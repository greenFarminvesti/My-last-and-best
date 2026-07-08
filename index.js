require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. CONFIG & ENV ---
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

// --- 2. FIREBASE INIT (Migration Source) ---
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin Initialized (Source)");
    }
} catch (e) {
    console.error("❌ Firebase Initialization Failed:", e.message);
}
const firestore = admin.apps.length ? admin.firestore() : null;

// --- 3. MONGODB INIT (Destination) ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Atlas Connected (Destination)"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- 4. SCHEMAS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    telegramId: { type: Number },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null },
    // Allow for extra fields that might exist in Firebase
}, { strict: false });

const withdrawalSchema = new mongoose.Schema({
    userId: String,
    telegramId: Number,
    amount: Number,
    fee: Number,
    receivingAmount: Number,
    status: String,
    date: { type: Date, default: Date.now },
    transferId: String,
    error: String
});

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- 5. MIGRATION ENDPOINTS ---

// POST /migrate-users - Manually move all users from Firebase to MongoDB
app.post('/migrate-users', async (req, res) => {
    const auth = req.header('X-API-Key');
    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    if (!firestore) return res.status(500).json({ error: "Firebase not connected" });

    try {
        console.log("🚀 Starting Bulk Migration...");
        const snapshot = await firestore.collection('users').get();
        
        if (snapshot.empty) {
            return res.json({ message: "No users found in Firebase to migrate." });
        }

        let migratedCount = 0;
        const bulkOps = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Convert Firebase Timestamp to JS Date if exists
            let lastWD = data.lastWithdrawalDate;
            if (lastWD && typeof lastWD.toDate === 'function') {
                lastWD = lastWD.toDate();
            }

            const userData = {
                userId: String(doc.id),
                telegramId: data.telegramId ? Number(data.telegramId) : null,
                totalBalance: data.totalBalance || 0,
                todayWithdrawals: data.todayWithdrawals || 0,
                lastWithdrawalDate: lastWD,
                ...data // Include any other fields
            };

            // Prepare Upsert Operation (Update if exists, Insert if not)
            bulkOps.push({
                updateOne: {
                    filter: { userId: userData.userId },
                    update: { $set: userData },
                    upsert: true
                }
            });
            migratedCount++;
        });

        if (bulkOps.length > 0) {
            await User.bulkWrite(bulkOps);
        }

        res.json({ 
            success: true, 
            message: `Migrated ${migratedCount} users to MongoDB.`,
            count: migratedCount 
        });

    } catch (err) {
        console.error("Migration Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /migration-status - Compare counts
app.get('/migration-status', async (req, res) => {
    try {
        const mongoCount = await User.countDocuments();
        let fireCount = 0;
        
        if (firestore) {
            const snapshot = await firestore.collection('users').count().get();
            fireCount = snapshot.data().count;
        }

        res.json({
            firebase_total: fireCount,
            mongodb_total: mongoCount,
            remaining: Math.max(0, fireCount - mongoCount),
            ready_to_switch: fireCount === mongoCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 6. WITHDRAWAL ROUTE (NOW MONGODB ONLY) ---

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        // 1. Check MongoDB ONLY (Assuming migration has been run)
        const user = await User.findOne({ userId: String(userId) });

        if (!user) {
            return res.status(404).json({ error: "User not found. Please ensure migration was run." });
        }

        // 2. Balance Check
        if (user.totalBalance < amount) {
            return res.status(400).json({ error: "Insufficient balance", balance: user.totalBalance });
        }

        // 3. Logic & xRocket
        const netAmount = Number((amount * 0.6).toFixed(2));
        const feeAmount = Number((amount * 0.4).toFixed(2));
        const uniqueTransferId = `wd_${uuidv4()}`;

        try {
            const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
                tgUserId: Number(telegramId),
                currency: 'DOGS',
                amount: netAmount,
                transferId: uniqueTransferId,
                description: `Withdrawal for User ${userId}`
            }, {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.success) {
                // UPDATE MONGODB
                await User.findOneAndUpdate(
                    { userId: String(userId) },
                    { 
                        $inc: { totalBalance: -amount, todayWithdrawals: 1 },
                        $set: { lastWithdrawalDate: new Date() }
                    }
                );

                await Withdrawal.create({
                    userId: String(userId),
                    telegramId: Number(telegramId),
                    amount: amount,
                    fee: feeAmount,
                    receivingAmount: netAmount,
                    status: 'paid',
                    transferId: uniqueTransferId
                });

                return res.json({ success: true, transferId: uniqueTransferId });
            } else {
                throw new Error(response.data.error?.message || "xRocket Transfer Failed");
            }
        } catch (xRocketErr) {
            const errMsg = xRocketErr.response?.data?.error?.message || xRocketErr.message;
            await Withdrawal.create({
                userId: String(userId),
                amount,
                status: 'failed',
                error: errMsg
            });
            return res.status(500).json({ error: errMsg });
        }

    } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        mongodb: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
        firebase: firestore ? "Connected" : "Disconnected"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Production Server listening on port ${PORT}`);
});
