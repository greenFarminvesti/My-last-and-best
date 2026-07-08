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

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

// --- 1. FIREBASE INIT ---
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (e) { console.error("Firebase Init Error"); }
const firestore = admin.apps.length ? admin.firestore() : null;

// --- 2. MONGODB INIT ---
mongoose.connect(MONGODB_URI).then(() => console.log("✅ MongoDB Connected"));

// --- 3. MODELS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    telegramId: { type: Number },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null },
}, { strict: false });

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', new mongoose.Schema({
    userId: String, telegramId: Number, amount: Number, status: String, date: { type: Date, default: Date.now }, transferId: String, error: String
}));

// --- 4. ROUTES ---

app.get('/migration-status', async (req, res) => {
    try {
        const mongoCount = await User.countDocuments();
        let fireCount = 0;
        if (firestore) {
            const snap = await firestore.collection('users').count().get();
            fireCount = snap.data().count;
        }
        res.json({ firebase_total: fireCount, mongodb_total: mongoCount, remaining: fireCount - mongoCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        // Find user in MongoDB
        const user = await User.findOne({ userId: String(userId) });
        if (!user) return res.status(404).json({ error: "User not found in MongoDB" });

        // Logic check
        if (user.totalBalance < amount) {
            return res.status(400).json({ error: `Insufficient app balance. You have ${user.totalBalance}` });
        }

        const netAmount = Number((amount * 0.6).toFixed(2));
        const uniqueId = `wd_${uuidv4()}`;

        console.log(`Attempting xRocket transfer: ${netAmount} DOGS to ${telegramId}`);

        // --- THE XROCKET CALL ---
        try {
            const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
                tgUserId: Number(telegramId),
                currency: 'DOGS',
                amount: netAmount,
                transferId: uniqueId,
                description: `Withdrawal for ${userId}`
            }, {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.success) {
                // UPDATE DB ONLY ON SUCCESS
                await User.findOneAndUpdate({ userId: String(userId) }, { 
                    $inc: { totalBalance: -amount, todayWithdrawals: 1 }, 
                    $set: { lastWithdrawalDate: new Date() }
                });

                await Withdrawal.create({ userId: String(userId), telegramId: Number(telegramId), amount, status: 'paid', transferId: uniqueId });
                
                return res.json({ success: true, transferId: uniqueId });
            } else {
                throw new Error("xRocket refused the transaction");
            }

        } catch (xErr) {
            // DETAILED ERROR CATCHING
            const xRocketErrorData = xErr.response?.data;
            console.error("❌ xRocket API Detail Error:", JSON.stringify(xRocketErrorData));

            const finalError = xRocketErrorData?.error?.message || xRocketErrorData?.message || xErr.message;

            await Withdrawal.create({ 
                userId: String(userId), 
                amount, 
                status: 'failed', 
                error: finalError 
            });

            // This will now return the REAL reason (e.g., "Insufficient funds in app wallet")
            return res.status(400).json({ 
                error: "xRocket Error", 
                details: finalError 
            });
        }

    } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/', (req, res) => res.json({ status: "Online", db: mongoose.connection.readyState === 1 }));

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
