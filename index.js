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
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized");
    }
} catch (e) {
    console.error("❌ Firebase Initialization Failed:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// --- 2. CONFIG CHECK ---
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

if (!XROCKET_API_KEY) console.error("❌ ERROR: XROCKET_API_KEY is missing!");
if (!API_SECRET) console.error("❌ ERROR: API_SECRET is missing!");

// --- 3. ROUTES ---

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

        const balance = doc.data().usdtBalance || 0;
        if (balance < amount) return res.status(400).json({ error: "Insufficient balance" });

        // Calculate 40% fee
        const netAmount = Number((amount - (amount * 0.4)).toFixed(2));

        // Call xRocket
        const response = await axios.post('https://pay.xrocket.exchange/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: `wd_${Date.now()}`,
            description: `Withdraw for ${userId}`
        }, {
            headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
        });

        // Deduct from Firebase
        await userRef.update({
            usdtBalance: admin.firestore.FieldValue.increment(-amount)
        });

        res.json({ success: true, transferId: response.data.data?.transferId });

    } catch (err) {
        console.error("Withdrawal Error:", err.message);
        res.status(500).json({ error: err.response?.data?.message || err.message });
    }
});

// --- 4. START SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
