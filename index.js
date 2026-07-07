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

// --- 2. THE STATUS PAGE (Fixes "Cannot GET /") ---
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

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        // Calculate 60% for user (40% fee)
        const netAmount = Number((amount * 0.6).toFixed(2));

        // UNIQUE ID
        const uniqueTxId = `wd_${userId}_${Date.now()}`;

        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: `Payout for ${userId}`
        }, {
            headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
        });

        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount)
            });
            return res.json({ success: true });
        } else {
            // Return the SPECIFIC error from xRocket to the user
            const xRocketError = response.data.error?.message || "Transfer Rejected";
            return res.status(400).json({ success: false, error: xRocketError });
        }

    } catch (err) {
        // This catches the 400 error and reads the response body
        console.error("XROCKET 400 ERROR:", err.response?.data);
        const detail = err.response?.data?.error?.message || err.message;
        res.status(400).json({ success: false, error: detail });
    }
});
