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
    res.json({ 
        status: "Server is Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

// --- 3. THE WITHDRAWAL ROUTE ---
// Ensure you send your request to: http://your-domain.com/withdraw
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    console.log(`Incoming request for User: ${userId}, Amount: ${amount}`);

    // Security Check
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid API Secret" });
    }

    if (!db) {
        return res.status(500).json({ success: false, error: "Database Connection Failed" });
    }

    // Validation
    if (!userId || !telegramId || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid Input Parameters" });
    }

    const netAmount = Math.floor(amount * 0.6); // 60% payout
    const uniqueTxId = `wd_${userId}_${Date.now()}`;

    try {
        // 1. Firebase Check
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found in DB" });
        }

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) {
            return res.status(400).json({ success: false, error: "Insufficient App Balance" });
        }

        // 2. xRocket API Call
        const requestBody = {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "Reward Payout"
        };

        console.log('Sending to xRocket:', requestBody);

        const response = await axios.post(
            'https://pay.xrocket.tg/api/transfer', // If this fails, try 'https://pay.xrocket.tg/app/transfer'
            requestBody,
            {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        // 3. Check xRocket Response
        if (response.data && response.data.success) {
            // Deduct from Firebase
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            // Log Transaction
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                netAmount: netAmount,
                status: 'success',
                transferId: uniqueTxId,
                date: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ success: true, message: "Payout Sent!", transferId: uniqueTxId });
        } else {
            console.error('xRocket logic failure:', response.data);
            return res.status(400).json({ success: false, error: response.data.message || "xRocket Rejected Transfer" });
        }

    } catch (err) {
        console.error('--- ERROR LOG ---');
        console.error('Status:', err.response?.status);
        console.error('Data:', JSON.stringify(err.response?.data, null, 2));
        
        const errorDetail = err.response?.data?.message || err.message;

        return res.status(err.response?.status || 500).json({
            success: false,
            error: errorDetail,
            step: "Final Catch Block"
        });
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`📍 Endpoint available at: POST http://localhost:${PORT}/withdraw`);
});
