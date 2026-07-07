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
        status: "Online", 
        url: "https://my-last-and-best-production.up.railway.app",
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Configured" : "Key Missing"
    });
});

// --- 3. WITHDRAWAL ROUTE ---
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Invalid API Secret" });
    }

    if (!db) {
        return res.status(500).json({ success: false, error: "Database not connected" });
    }

    // Input Validation
    if (!userId || !telegramId || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: "Missing or invalid parameters" });
    }

    const netAmount = Math.floor(amount * 0.6); // 60% Payout to user
    const uniqueTxId = `tx_${userId}_${Date.now()}`;

    try {
        // 1. Verify User Balance in Firebase
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found" });
        }

        const currentBalance = doc.data().totalBalance || 0;
        if (currentBalance < amount) {
            return res.status(400).json({ success: false, error: "Insufficient balance" });
        }

        // 2. Request to xRocket Pay
        // URL based on your provided endpoint
        const xrocketUrl = 'https://pay.xrocket.exchange/api/app/transfer';
        
        const payload = {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: uniqueTxId,
            description: "App Withdrawal"
        };

        console.log(`📤 Requesting transfer for ${telegramId}...`);

        const response = await axios.post(xrocketUrl, payload, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        // 3. Handle xRocket Response
        if (response.data && response.data.success) {
            // Update Firebase: Deduct balance and record withdrawal
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                totalWithdrawn: admin.firestore.FieldValue.increment(amount)
            });

            await db.collection('withdrawals').add({
                userId: String(userId),
                tgId: Number(telegramId),
                originalAmount: amount,
                payoutAmount: netAmount,
                status: 'completed',
                transferId: uniqueTxId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ 
                success: true, 
                message: "Withdrawal successful", 
                transferId: uniqueTxId 
            });
        } else {
            // Logic failure (e.g., bot has no funds)
            console.error("❌ xRocket logic error:", response.data);
            return res.status(400).json({ 
                success: false, 
                error: response.data.message || "Transfer rejected by xRocket" 
            });
        }

    } catch (err) {
        console.error("❌ API ERROR:");
        if (err.response) {
            // This is where you see WHY it's a "Bad Request"
            console.error("Data:", err.response.data);
            return res.status(400).json({ 
                success: false, 
                error: "xRocket Error", 
                details: err.response.data 
            });
        }
        return res.status(500).json({ success: false, error: err.message });
    }
});

// --- 4. START SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
