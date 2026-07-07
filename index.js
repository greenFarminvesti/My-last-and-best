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

app.get('/', (req, res) => res.json({ status: "Online", service: "DOGS Payout" }));

// --- 2. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // Parameters Validation
    const numTgId = Number(telegramId);
    const numAmount = Number(amount); // This is what the user requested from your app

    if (!userId || !numTgId || isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters" });
    }

    // Logic: User gets 60%, 40% stays in your app as fees
    // DOGS is usually handled as a whole number or 2 decimals
    const netAmount = Math.floor(numAmount * 0.6); 
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found in database" });
        }

        const userBalance = doc.data().totalBalance || 0;

        if (userBalance < numAmount) {
            return res.status(400).json({ success: false, error: "Insufficient balance in user account" });
        }

        // --- xROCKET API CALL ---
        // Using the correct production endpoint
        const xrocketUrl = 'https://pay.xrocket.exchange/api/transfer';

        const payload = {
            tgUserId: numTgId,
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "DOGS Reward Payout"
        };

        console.log(`📤 Sending ${netAmount} DOGS to Telegram ID: ${numTgId}`);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        // --- SUCCESS HANDLING ---
        if (response.data && response.data.success) {
            // Deduct the FULL amount from user's app balance
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });

            console.log(`✅ Transfer Successful: ${uniqueTxId}`);
            
            return res.status(201).json({ 
                success: true, 
                transferId: uniqueTxId,
                sentAmount: netAmount,
                data: response.data.data 
            });
        } else {
            throw new Error(response.data?.message || "xRocket Unknown Error");
        }

    } catch (err) {
        console.error("❌ XROCKET API ERROR:");
        
        if (err.response) {
            // This captures the 400 error and displays the reason (like "Insufficient Balance")
            console.error("Status:", err.response.status);
            console.error("Details:", JSON.stringify(err.response.data, null, 2));

            return res.status(err.response.status).json({
                success: false,
                error: "xRocket API Error",
                message: err.response.data.message || "Transfer failed",
                details: err.response.data.errors || []
            });
        }
        
        console.error(err.message);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 DOGS Payout Server running on port ${PORT}`);
});
