require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. FIREBASE ADMIN INIT ---
try {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Connected");
    }
} catch (e) {
    console.error("❌ Firebase Init Error:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

// --- 2. STATUS PAGE ---
app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

// --- 3. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!db) return res.status(500).json({ error: "Database not connected" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) return res.status(400).json({ error: "Insufficient balance in App" });

        // Calculate 60% for user (40% fee)
        const netAmount = Number((amount * 0.6).toFixed(2));

        // Inside Railway index.js
const uniqueTxId = `wd_${userId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
    tgUserId: Number(telegramId), // Must be numeric
    currency: 'DOGS',
    amount: Math.floor(amount * 0.6), // Net amount after 40% fee
    transferId: uniqueTxId, // MUST be unique per request
    description: "Watch Reward Payout"
}, {
    headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
});

        if (response.data && response.data.success) {
            // 1. Deduct balance from user
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            // 2. SAVE TO HISTORY (This makes it appear in the App's History tab)
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                receivingAmount: netAmount,
                status: 'paid',
                date: admin.firestore.FieldValue.serverTimestamp(),
                transferId: response.data.data?.transferId || uniqueTxId
            });

            return res.json({ success: true });
        } else {
            console.error("xRocket Rejection:", response.data);
            const xRocketError = response.data.error?.message || "Transfer Rejected";
            return res.status(400).json({ success: false, error: xRocketError });
        }

    } catch (err) {
        // Detailed logging for Railway Logs
        console.error("XROCKET ERROR:", err.response?.data || err.message);
        
        const detail = err.response?.data?.error?.message || err.message;
        
        // Log the failure to the database so you can see it in history
        if (db && userId) {
            await db.collection('withdrawals').add({
                userId: String(userId),
                amount: amount,
                status: 'failed',
                error: detail,
                date: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }

        res.status(400).json({ success: false, error: detail });
    }
});

// --- 4. START THE SERVER (CRITICAL FIX) ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
