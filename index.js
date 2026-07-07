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

// --- 3. THE WITHDRAWAL ROUTE (UPDATED) ---
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
        const netAmount = Number((amount * 0.6).toFixed(2));
        const amountInCents = Math.round(netAmount * 100); // Convert to cents if needed
        const amountInteger = Math.floor(netAmount); // Or keep as integer

        // Generate unique transaction ID
        const uniqueTxId = `wd_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Log the request for debugging
        console.log('📤 Sending to xRocket:', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: amountInteger,
            transferId: uniqueTxId,
            description: "Watch Reward Payout"
        });

        // --- XROCKET API CALL ---
        const response = await axios.post(
            'https://pay.xrocket.tg/app/transfer',
            {
                tgUserId: Number(telegramId),
                currency: 'DOGS',
                amount: amountInteger,
                transferId: uniqueTxId,
                description: "Watch Reward Payout"
            },
            {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 10000 // 10 second timeout
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
                transferId: response.data.data?.transferId || uniqueTxId,
                xRocketResponse: response.data // Store full response for reference
            });

            return res.json({ 
                success: true, 
                message: "Withdrawal successful",
                transferId: response.data.data?.transferId || uniqueTxId,
                amount: netAmount
            });
        } else {
            // Handle xRocket rejection
            const errorMsg = response.data?.error?.message || 
                           response.data?.message || 
                           'Transfer rejected by xRocket';
            
            console.error('❌ xRocket Rejection:', response.data);
            
            // Log failure to database
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                status: 'failed',
                error: errorMsg,
                date: admin.firestore.FieldValue.serverTimestamp(),
                xRocketResponse: response.data
            }).catch(() => {});

            return res.status(400).json({ 
                success: false, 
                error: errorMsg,
                details: response.data 
            });
        }

    } catch (err) {
        // Enhanced error logging
        console.error('❌ XROCKET ERROR:');
        console.error('Status:', err.response?.status);
        console.error('Data:', err.response?.data);
        console.error('Message:', err.message);
        
        if (err.response) {
            console.error('Headers:', err.response.headers);
        }

        const errorDetail = err.response?.data?.error?.message || 
                           err.response?.data?.message || 
                           err.message;

        // Log failure to database
        if (db && userId) {
            try {
                await db.collection('withdrawals').add({
                    userId: String(userId),
                    telegramId: Number(telegramId),
                    amount: amount || 0,
                    status: 'failed',
                    error: errorDetail,
                    date: admin.firestore.FieldValue.serverTimestamp(),
                    fullError: err.response?.data || err.message
                });
            } catch (dbErr) {
                console.error('❌ Failed to log to database:', dbErr.message);
            }
        }

        // Send appropriate response based on error type
        if (err.code === 'ECONNABORTED') {
            return res.status(504).json({ 
                success: false, 
                error: "Request timeout - xRocket took too long to respond" 
            });
        }

        if (err.response) {
            return res.status(err.response.status || 400).json({ 
                success: false, 
                error: errorDetail,
                status: err.response.status,
                details: err.response.data 
            });
        }

        res.status(500).json({ 
            success: false, 
            error: "Internal server error: " + errorDetail 
        });
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`📋 API Key present: ${API_SECRET ? 'Yes' : 'No'}`);
    console.log(`📋 xRocket Key present: ${XROCKET_API_KEY ? 'Yes' : 'No'}`);
});
