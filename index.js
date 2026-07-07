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

app.get('/', (req, res) => res.json({ status: "Online", currency: "DOGS" }));

// --- 2. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const authHeader = req.header('X-API-Key');

    // 1. Security Check
    if (authHeader !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // 2. Data Validation
    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    if (!userId || !numTgId || isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid input parameters" });
    }

    // 3. Calculate payout (60% to user)
    // DOGS does not support many decimals. We use Math.floor to be safe.
    const netAmount = Math.floor(numAmount * 0.6); 
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) return res.status(404).json({ success: false, error: "User not found" });

        const currentBalance = doc.data().totalBalance || 0;
        if (currentBalance < numAmount) {
            return res.status(400).json({ success: false, error: "Insufficient user balance" });
        }

        // --- xROCKET v1 API CALL ---
        const xrocketUrl = 'https://pay.api.xrocket.exchange/api/v1/app/transfer';

        const payload = {
            tgUserId: numTgId,
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId, // Prevents double-spending
            description: "DOGS Payout"
        };

        console.log(`📤 Sending ${netAmount} DOGS to TG ID ${numTgId}...`);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY, // Main header
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // --- 4. SUCCESS: Update Firestore ---
        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });

            console.log(`✅ Success! TxID: ${uniqueTxId}`);
            
            return res.status(200).json({ 
                success: true, 
                amountSent: netAmount,
                transfer: response.data.data 
            });
        } else {
            throw new Error(response.data?.message || "Transfer failed");
        }

    } catch (err) {
        console.error("❌ XROCKET v1 API ERROR:");
        
        if (err.response) {
            // This captures the 400 error (like "Insufficient Balance")
            console.error("Data:", JSON.stringify(err.response.data, null, 2));
            return res.status(err.response.status).json({
                success: false,
                error: "xRocket Error",
                message: err.response.data.message || "Unknown xRocket error",
                errors: err.response.data.errors
            });
        }
        
        console.error(err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 v1 DOGS Payout Server online on port ${PORT}`);
});
