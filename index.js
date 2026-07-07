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
        console.log("✅ Firebase Connected");
    }
} catch (e) {
    console.error("❌ Firebase Error:", e.message);
}

const db = admin.firestore();
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

// URL from your documentation fix
const XROCKET_BASE_URL = 'https://pay.api.xrocket.exchange/api/v1';

app.get('/', (req, res) => res.json({ status: "Online" }));

// --- DEBUG ROUTE: Check your actual DOGS balance ---
// Open this in your browser: your-app-url.up.railway.app/check-balance
app.get('/check-balance', async (req, res) => {
    try {
        const response = await axios.get(`${XROCKET_BASE_URL}/app/info`, {
            headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
        });
        // This will show you exactly how many DOGS the API sees in your App
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message, details: err.response?.data });
    }
});

// --- 3. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });

    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    if (!userId || !numTgId || !numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters" });
    }

    // User gets 60%
    const netAmount = Math.floor(numAmount * 0.6); 
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) return res.status(404).json({ success: false, error: "User not found" });
        if ((doc.data().totalBalance || 0) < numAmount) return res.status(400).json({ success: false, error: "Insufficient user balance" });

        // Correct Endpoint for v1
        const xrocketUrl = `${XROCKET_BASE_URL}/app/transfer`;

        const payload = {
            tgUserId: numTgId,
            currency: 'DOGS', // Ensure this is exactly 'DOGS'
            amount: netAmount,
            transferId: uniqueTxId,
            description: "DOGS Reward Payout"
        };

        console.log(`📤 Attempting to send ${netAmount} DOGS to ${numTgId}`);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });
            return res.json({ success: true, transfer: response.data.data });
        } else {
            throw new Error(response.data?.message || "xRocket Error");
        }

    } catch (err) {
        console.error("❌ XROCKET API ERROR:");
        
        if (err.response) {
            console.error("Status:", err.response.status);
            console.error("Body:", JSON.stringify(err.response.data, null, 2));

            return res.status(err.response.status).json({
                success: false,
                error: "xRocket Error",
                details: err.response.data // This will tell you if it's still saying "0 balance"
            });
        }
        
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on port ${PORT}`));
