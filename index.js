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
        console.log("✅ Firebase Connected");
    }
} catch (e) { console.error("❌ Firebase Init Failed:", e.message); }
const firestore = admin.apps.length ? admin.firestore() : null;

// --- 2. MONGODB INIT ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- 3. MODELS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    telegramId: { type: Number },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null },
}, { strict: false });

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema = new mongoose.Schema({
    userId: String, telegramId: Number, amount: Number, status: String, date: { type: Date, default: Date.now }, transferId: String, error: String
}));

// --- 4. MIGRATION LOGIC (Helper for Browser) ---

// This allows you to just click a link in your browser to start the migration
app.get('/start-migration', async (req, res) => {
    const key = req.query.key; // Get key from ?key=...
    if (key !== API_SECRET) return res.status(401).send("Invalid API Secret in URL");

    if (!firestore) return res.status(500).send("Firebase not connected");

    try {
        const snapshot = await firestore.collection('users').get();
        if (snapshot.empty) return res.send("Firebase is empty.");

        let bulkOps = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            let lastWD = data.lastWithdrawalDate;
            if (lastWD && typeof lastWD.toDate === 'function') lastWD = lastWD.toDate();

            bulkOps.push({
                updateOne: {
                    filter: { userId: String(doc.id) },
                    update: { $set: { 
                        userId: String(doc.id),
                        telegramId: data.telegramId || null,
                        totalBalance: data.totalBalance || 0,
                        todayWithdrawals: data.todayWithdrawals || 0,
                        lastWithdrawalDate: lastWD,
                        ...data 
                    }},
                    upsert: true
                }
            });
        });

        if (bulkOps.length > 0) await User.bulkWrite(bulkOps);
        res.send(`Successfully migrated ${bulkOps.length} users to MongoDB! You can now check /migration-status again.`);
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

// --- 5. STATUS & WITHDRAWAL ---

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
            ready_to_switch: fireCount > 0 && fireCount === mongoCount
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');
    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        const user = await User.findOne({ userId: String(userId) });
        if (!user) return res.status(404).json({ error: "User not found in MongoDB. Run migration first." });
        if (user.totalBalance < amount) return res.status(400).json({ error: "Insufficient balance" });

        const netAmount = Number((amount * 0.6).toFixed(2));
        const uniqueTransferId = `wd_${uuidv4()}`;

        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId), currency: 'DOGS', amount: netAmount, transferId: uniqueTransferId, description: `Withdrawal ${userId}`
        }, { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY, 'Content-Type': 'application/json' }});

        if (response.data && response.data.success) {
            await User.findOneAndUpdate({ userId: String(userId) }, { $inc: { totalBalance: -amount, todayWithdrawals: 1 }, $set: { lastWithdrawalDate: new Date() }});
            await Withdrawal.create({ userId: String(userId), telegramId: Number(telegramId), amount, status: 'paid', transferId: uniqueTransferId });
            return res.json({ success: true, transferId: uniqueTransferId });
        } else {
            throw new Error(response.data.error?.message || "Transfer Failed");
        }
    } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        await Withdrawal.create({ userId: String(userId), amount, status: 'failed', error: errMsg });
        res.status(500).json({ error: errMsg });
    }
});

app.get('/', (req, res) => res.json({ status: "Running", mongo: mongoose.connection.readyState === 1 }));

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on port ${PORT}`));
