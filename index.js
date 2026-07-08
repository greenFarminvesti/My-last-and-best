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
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("✅ Firebase Initialized");
        }
    }
} catch (e) { console.error("❌ Firebase Init Error:", e.message); }
const firestore = admin.apps.length ? admin.firestore() : null;

// --- 2. MONGODB INIT ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err.message));

// --- 3. MODELS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    telegramId: { type: Number },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null },
}, { strict: false });

const withdrawalSchema = new mongoose.Schema({
    userId: String,
    telegramId: Number,
    amount: Number,
    status: String,
    date: { type: Date, default: Date.now },
    transferId: String,
    error: String
});

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- 4. MIGRATION ROUTES ---

// Call this in browser: /start-migration?key=YOUR_SECRET
app.get('/start-migration', async (req, res) => {
    if (req.query.key !== API_SECRET) return res.status(401).send("Invalid Key");
    if (!firestore) return res.status(500).send("Firebase not connected");

    try {
        const snapshot = await firestore.collection('users').get();
        let bulkOps = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            bulkOps.push({
                updateOne: {
                    filter: { userId: String(doc.id) },
                    update: { $set: { ...data, userId: String(doc.id) } },
                    upsert: true
                }
            });
        });
        if (bulkOps.length > 0) await User.bulkWrite(bulkOps);
        res.send(`Migration Complete. Moved ${bulkOps.length} users.`);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/migration-status', async (req, res) => {
    try {
        const mongoCount = await User.countDocuments();
        let fireCount = 0;
        if (firestore) {
            const snap = await firestore.collection('users').count().get();
            fireCount = snap.data().count;
        }
        res.json({ firebase: fireCount, mongodb: mongoCount, remaining: fireCount - mongoCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 5. WITHDRAWAL ROUTE ---

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        const user = await User.findOne({ userId: String(userId) });
        if (!user) return res.status(404).json({ error: "User not in MongoDB. Run /start-migration" });

        if (user.totalBalance < amount) {
            return res.status(400).json({ error: `Insufficient Balance. Have: ${user.totalBalance}, Need: ${amount}` });
        }

        const netAmount = Number((amount * 0.6).toFixed(2));
        const uniqueId = `wd_${uuidv4()}`;

        try {
            // CALL XROCKET
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
                await User.findOneAndUpdate({ userId: String(userId) }, { 
                    $inc: { totalBalance: -amount, todayWithdrawals: 1 }, 
                    $set: { lastWithdrawalDate: new Date() }
                });
                await Withdrawal.create({ userId, telegramId, amount, status: 'paid', transferId: uniqueId });
                return res.json({ success: true, transferId: uniqueId });
            }
        } catch (xErr) {
            // THIS TELLS YOU THE EXACT PROBLEM
            const detail = xErr.response?.data?.error?.message || xErr.response?.data?.message || xErr.message;
            console.error("xRocket Error Detail:", detail);
            
            await Withdrawal.create({ userId, amount, status: 'failed', error: detail });
            return res.status(400).json({ error: "xRocket Error", details: detail });
        }
    } catch (err) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.get('/', (req, res) => res.json({ status: "Online", db: mongoose.connection.readyState === 1 }));

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
