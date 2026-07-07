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

// --- 3. THE WITHDRAWAL ROUTE (FIXED) ---
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

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) {
            return res.status(400).json({ 
                error: "Insufficient balance in App",
                balance: balance,
                requested: amount
            });
        }

        // Calculate 60% for user (40% fee)
        const netAmount = Math.floor(amount * 0.6); // Ensure it's an integer
        
        // IMPORTANT: xRocket might expect amount in the smallest unit
        // If DOGS has decimals, use netAmount directly
        // If DOGS is like TON (with 9 decimals), multiply by 10^9
        const amountToSend = netAmount; // Adjust this based on xRocket's requirements

        // Generate unique transaction ID
        const uniqueTxId = `wd_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // --- FIXED: xRocket API Call with correct format ---
        const requestBody = {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: amountToSend,
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

        console.log('📥 xRocket Response:', response.data);

        // Check for success
        if (response.data && response.data.success === true) {
            // 1. Deduct balance from user
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            // 2. Save to history
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
            const errorMsg = response.data?.error?.message || 
                           response.data?.message || 
                           'Transfer rejected by xRocket';
            
            console.error('❌ xRocket Rejection:', response.data);
            
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                status: 'failed',
                error: errorMsg,
                date: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});

            return res.status(400).json({ 
                success: false, 
                error: errorMsg,
                details: response.data 
            });
        }

    } catch (err) {
        console.error('❌ XROCKET ERROR:');
        console.error('Status:', err.response?.status);
        console.error('Data:', JSON.stringify(err.response?.data, null, 2));
        console.error('Message:', err.message);
        
        // Check if it's a validation error
        if (err.response?.status === 400) {
            const errorDetail = err.response?.data?.error?.message || 
                               err.response?.data?.message || 
                               'Bad request - check parameters';
            
            console.error('Bad Request Details:', errorDetail);
            
            // Log to database
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
                    console.error('Failed to log to database:', dbErr.message);
                }
            }
            
            return res.status(400).json({
                success: false,
                error: errorDetail,
                return res.status(400).json({
    success: false,
    error: errorDetail,
    sentData: {
        tgUserId: Number(telegramId),
        currency: "DOGS",
        amount: Math.floor(amount * 0.6),
        transferId: uniqueTxId
    }
});

        res.status(500).json({ 
            success: false, 
            error: "Internal server error: " + err.message 
        });
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
