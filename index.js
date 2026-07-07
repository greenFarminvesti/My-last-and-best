require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. SAFE FIREBASE INIT ---
try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT variable is empty!");
    } else {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        console.log("✅ Firebase Admin Initialized");
    }
} catch (e) {
    console.error("❌ Firebase Initialization Failed:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!db) return res.status(500).json({ error: "Firebase not connected" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        const balance = doc.data().totalBalance || 0; 
        if (balance < amount) {
            return res.status(400).json({ error: "Insufficient balance in App" });
        }

        // Calculate 40% fee (User gets 60%)
        const netAmount = Number((amount * 0.6).toFixed(2));

        // --- FIX: GENERATE A TRULY UNIQUE TRANSFER ID ---
        // This includes the UserID, the Timestamp, and a Random Number
        const uniqueTransferId = `wd_${userId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTransferId, // Fixed unique ID
            description: `Withdrawal for ${userId}`
        }, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                todayWithdrawals: admin.firestore.FieldValue.increment(1),
                lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                fee: amount * 0.4,
                receivingAmount: netAmount,
                status: 'paid',
                date: admin.firestore.FieldValue.serverTimestamp(),
                transferId: response.data.data?.transferId || uniqueTransferId
            });

            return res.json({ success: true, transferId: response.data.data?.transferId });
        } else {
            console.error("xRocket Failed Response:", response.data);
            return res.status(400).json({ error: response.data.error?.message || "xRocket Rejection" });
        }

    } catch (err) {
        // Log the ENTIRE error response from xRocket to debug "Bad Request"
        console.error("XROCKET ERROR DEBUG:", err.response?.data || err.message);
        
        const errorMessage = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        
        if (db) {
            await db.collection('withdrawals').add({
                userId: String(userId || "unknown"),
                amount: amount || 0,
                status: 'failed',
                error: errorMessage,
                date: admin.firestore.FieldValue.serverTimestamp()
            }).catch(()=>{});
        }

        res.status(500).json({ success: false, error: errorMessage });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
