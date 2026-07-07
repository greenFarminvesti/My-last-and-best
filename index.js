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
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin Connected");
    }
} catch (e) { console.error("❌ Firebase Init Error:", e.message); }

const db = admin.firestore();
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

// --- 2. WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        // Calculate 60% for user (40% fee)
        const netAmount = Number((amount * 0.6).toFixed(2));

        // FIX: Unique Transfer ID prevents "Bad Request"
        const uniqueTxId = `wd_${userId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId), // MUST be a number
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: `Withdrawal for ID: ${userId}`
        }, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.success) {
            // SUCCESS: Atomic update to database
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount),
                todayWithdrawals: admin.firestore.FieldValue.increment(1),
                lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                netAmount: netAmount,
                status: 'paid',
                date: admin.firestore.FieldValue.serverTimestamp(),
                transferId: response.data.data?.transferId || uniqueTxId
            });

            return res.json({ success: true });
        } else {
            return res.status(400).json({ error: response.data.error?.message || "xRocket Rejection" });
        }

    } catch (err) {
        console.error("XROCKET API ERROR:", err.response?.data || err.message);
        const errorMsg = err.response?.data?.error?.message || err.message;
        res.status(500).json({ success: false, error: errorMsg });
    }
});

app.listen(process.env.PORT || 3000, "0.0.0.0", () => { console.log("🚀 Server Live"); });
