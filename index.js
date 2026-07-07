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
        status: "Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

// --- 3. THE WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (!db) {
        return res.status(500).json({ error: "Database not connected" });
    }

    // Validate inputs
    if (!userId || !telegramId || !amount || amount <= 0) {
        return res.status(400).json({ 
            error: "Missing or invalid parameters",
            required: { userId: "string", telegramId: "number", amount: "number > 0" }
        });
    }

    // Define unique ID outside try block so catch can access it
    const uniqueTxId = `wd_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const netAmount = Math.floor(amount * 0.6); // 60% payout

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) {
            return res.status(400).json({ 
                error: "Insufficient balance",
                balance: balance,
                requested: amount
            });
        }

        const requestBody = {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "Watch Reward Payout"
        };

        console.log('📤 Sending to xRocket:', JSON.stringify(requestBody, null, 2));

        const response = await axios.post(
            'https://pay.xrocket.tg/app/transfer',
            requestBody,
            {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 10000
            }
        );

        // Check for success
        if (response.data && response.data.success === true) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                receivingAmount: netAmount,
                status: 'paid',
                date: admin.firestore.FieldValue.serverTimestamp(),
                transferId: response.data.data?.transferId || uniqueTxId
            });

            return res.json({ 
                success: true, 
                message: "Withdrawal successful",
                transferId: response.data.data?.transferId || uniqueTxId,
                amount: netAmount
            });
        } else {
            throw new Error(response.data?.message || 'Transfer rejected by xRocket');
        }

    } catch (err) {
        console.error('❌ ERROR OCCURRED:');
        const errorDetail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        
        console.error('Details:', errorDetail);
        
        // Log failure to database
        if (db && userId) {
            try {
                await db.collection('withdrawals').add({
                    userId: String(userId),
                    telegramId: Number(telegramId),
                    amount: amount || 0,
                    status: 'failed',
                    error: errorDetail,
                    date: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (dbErr) {
                console.error('Failed to log error to DB:', dbErr.message);
            }
        }

        return res.status(err.response?.status || 500).json({ 
            success: false, 
            error: errorDetail,
            sentData: {
                tgUserId: Number(telegramId),
                currency: "DOGS",
                amount: netAmount,
                transferId: uniqueTxId
            }
        });
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
