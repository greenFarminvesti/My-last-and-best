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
    res.json({ status: "Online", serverTime: new Date().toISOString() });
});

// --- 3. WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!db) return res.status(500).json({ error: "Database offline" });

    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    if (!userId || isNaN(numTgId) || isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: "Invalid parameters" });
    }

    const netAmount = Math.floor(numAmount * 0.6); 
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        const balance = doc.data().totalBalance || 0;
        if (balance < numAmount) return res.status(400).json({ error: "Insufficient balance" });

        // --- THE DEFINITIVE FIX: App Transfer Endpoint ---
        // Most xRocket Apps now use the v1/app/transfer path
        const xrocketUrl = 'https://pay.xrocket.tg/v1/app/transfer';

        const payload = {
            tgUserId: numTgId,
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "App Payout"
        };

        console.log(`📤 Sending Request to: ${xrocketUrl}`);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });

            return res.json({ success: true, transferId: uniqueTxId });
        } else {
            throw new Error(response.data?.message || "Transfer failed");
        }

    } catch (err) {
        console.error("❌ XROCKET ERROR LOG:");
        
        // Log the exact URL that failed to help debug
        if (err.response) {
            console.error("URL Attempted:", err.config.url);
            console.error("Status Code:", err.response.status);
            console.error("Response Data:", JSON.stringify(err.response.data, null, 2));

            return res.status(err.response.status).json({
                success: false,
                error: "xRocket Rejected Request",
                details: err.response.data
            });
        }
        
        console.error("Message:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
