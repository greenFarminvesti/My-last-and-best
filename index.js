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
// IMPORTANT: Send your request to: http://your-domain.com/withdraw
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized: Invalid API Secret" });
    }

    if (!db) {
        return res.status(500).json({ success: false, error: "Database Connection Failed" });
    }

    // Validation - Ensure data is present and amount is a number
    if (!userId || !telegramId || !amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid Input: Missing or zero values" });
    }

    const netAmount = Math.floor(Number(amount) * 0.6); // 60% Payout
    const uniqueTxId = `wd_${userId}_${Date.now()}`;

    try {
        // 1. Firebase Balance Check
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found in Firebase" });
        }

        const balance = doc.data().totalBalance || 0;
        if (balance < amount) {
            return res.status(400).json({ success: false, error: "Insufficient user balance" });
        }

        // 2. xRocket API Call using the specific URL you provided
        // Combined URL: https://pay.xrocket.exchange/api/app/transfer
        const requestBody = {
            tgUserId: Number(telegramId), // MUST be a number
            currency: 'DOGS',
            amount: netAmount,            // MUST be a number
            transferId: uniqueTxId,
            description: "App Withdrawal Payout"
        };

        console.log('📤 Outgoing Request to xRocket:', requestBody);

        const response = await axios.post(
            'https://pay.xrocket.exchange/api/app/transfer',
            requestBody,
            {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000
            }
        );

        // 3. Handle xRocket Response
        // xRocket Pay usually returns { success: true, data: { ... } }
        if (response.data && response.data.success) {
            // Update User Balance in Firebase
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            // Log Transaction in History
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amountSent: amount,
                netReceived: netAmount,
                status: 'success',
                transferId: uniqueTxId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ 
                success: true, 
                message: "Payout successful", 
                transferId: uniqueTxId 
            });
        } else {
            console.error('❌ xRocket Logic Error:', response.data);
            return res.status(400).json({ 
                success: false, 
                error: response.data.message || "xRocket rejected transfer" 
            });
        }

    } catch (err) {
        console.error('--- ERROR DEBUG LOG ---');
        
        if (err.response) {
            // The API responded with a status code outside of 2xx
            console.error('xRocket Error Data:', JSON.stringify(err.response.data, null, 2));
            console.error('Status:', err.response.status);
            
            return res.status(err.response.status).json({
                success: false,
                error: err.response.data.message || "Bad Request from xRocket",
                details: err.response.data
            });
        } else {
            // Something happened in setting up the request
            console.error('Connection Error:', err.message);
            return res.status(500).json({
                success: false,
                error: "Internal Server Error or Connection Timeout"
            });
        }
    }
});

// --- 4. START THE SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server active on port ${PORT}`);
    console.log(`📡 Local Access: http://localhost:${PORT}/withdraw`);
});
