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

const db = admin.apps.length ? admin.firestore() : null;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({ status: "Online", service: "Withdrawal API" }));

// --- 3. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security
    if (auth !== API_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });
    if (!db) return res.status(500).json({ success: false, error: "Database offline" });

    // Formatting
    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    if (!userId || !numTgId || !numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters" });
    }

    const netAmount = Math.floor(numAmount * 0.6); // 60% payout
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        // 1. Check User in Firebase
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) return res.status(404).json({ success: false, error: "User not found" });
        if ((doc.data().totalBalance || 0) < numAmount) {
            return res.status(400).json({ success: false, error: "Insufficient balance" });
        }

        // --- THE OFFICIAL ENDPOINT FIX ---
        // Domain: pay.xrocket.tg | Path: /api/transfer
        const xrocketUrl = 'https://pay.xrocket.tg/api/transfer';

        const payload = {
            tgUserId: numTgId,   // Field name must be tgUserId
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "App Reward Payout"
        };

        console.log(`📤 POSTing to: ${xrocketUrl}`);
        console.log(`📦 Payload:`, payload);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        // 2. Success Logic
        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });

            return res.json({ 
                success: true, 
                message: "Payout successful", 
                transferId: uniqueTxId 
            });
        } else {
            throw new Error(response.data?.message || "xRocket internal failure");
        }

    } catch (err) {
        console.error("❌ XROCKET ERROR LOG:");
        
        if (err.response) {
            // This catches 400, 404, 500 errors from the server
            console.error("Status:", err.response.status);
            console.error("Response Body:", JSON.stringify(err.response.data, null, 2));

            return res.status(err.response.status).json({
                success: false,
                error: "xRocket API Error",
                details: err.response.data // Look here for the specific reason!
            });
        }
        
        console.error("System Error:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
