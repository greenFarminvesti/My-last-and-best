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
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("Missing FIREBASE_SERVICE_ACCOUNT in .env");
        }
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

    // Security Checks
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!db) {
        return res.status(500).json({ success: false, error: "Database not connected" });
    }

    // Validate Input Types
    if (!userId || !telegramId || !amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ 
            success: false, 
            error: "Invalid parameters. Ensure amount is a number and IDs are provided." 
        });
    }

    // Prepare variables
    const netAmount = Math.floor(Number(amount) * 0.6); // 60% payout
    const uniqueTxId = `wd_${userId}_${Date.now()}`;

    try {
        // 1. Check User in Firebase
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found in database" });
        }

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) {
            return res.status(400).json({ 
                success: false, 
                error: "Insufficient balance in app",
                userBalance: balance,
                requested: amount
            });
        }

        // 2. Call xRocket API
        // NOTE: We use /api/transfer as it is the standard for business-to-user transfers
        const requestBody = {
            tgUserId: Number(telegramId), 
            currency: 'DOGS',
            amount: netAmount, 
            transferId: uniqueTxId,
            description: "Reward Payout"
        };

        console.log('📤 Outgoing Request:', requestBody);

        const response = await axios.post(
            'https://pay.xrocket.tg/api/transfer',
            requestBody,
            {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        // 3. Handle xRocket Success
        if (response.data && response.data.success) {
            // Deduct balance from Firebase
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            // Log successful withdrawal
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                netAmount: netAmount,
                status: 'success',
                transferId: uniqueTxId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ 
                success: true, 
                message: "Transfer completed", 
                transferId: uniqueTxId,
                sentAmount: netAmount 
            });
        } else {
            throw new Error(response.data?.message || "Unknown xRocket Error");
        }

    } catch (err) {
        // --- ADVANCED ERROR LOGGING ---
        const errorData = err.response?.data;
        const errorMsg = errorData?.message || errorData?.error || err.message;
        
        console.error('❌ WITHDRAWAL FAILED:');
        console.error('Status Code:', err.response?.status);
        console.error('Full Error Response:', JSON.stringify(errorData, null, 2));

        // Log failure to Firebase for your own records
        if (db && userId) {
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                status: 'failed',
                error: errorMsg,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }

        // Return detailed error to help you fix "Bad Request"
        return res.status(err.response?.status || 500).json({
            success: false,
            error: errorMsg,
            reason: errorData?.code || "API_ERROR",
            suggestion: "Check if your xRocket App has enough DOGS balance and if the API Key has transfer permissions."
        });
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
