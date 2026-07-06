require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. SAFE FIREBASE INIT ---
try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT variable is empty!");
    } else {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin Initialized");
    }
} catch (e) {
    console.error("❌ Firebase Initialization Failed:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// --- 2. CONFIG CHECK ---
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

// --- 3. ROUTES ---

app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // Security Check
    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!db) return res.status(500).json({ error: "Firebase not connected" });

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ error: "User not found" });

        // BUG FIX 1: Changed usdtBalance to totalBalance to match your Database
        const balance = doc.data().totalBalance || 0; 
        
        console.log(`Withdraw request: User ${userId} has ${balance}, wants to withdraw ${amount}`);

        if (balance < amount) {
            return res.status(400).json({ error: "Insufficient balance in App" });
        }

        // Calculate 40% fee (User gets 60%)
        const netAmount = Number((amount * 0.6).toFixed(2));

        // BUG FIX 2: Updated xRocket URL to the correct stable endpoint
        // Calling xRocket
        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: `wd_${Date.now()}`,
            description: `Withdrawal for User ${userId}`
        }, {
            headers: { 
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        // If xRocket returns success
        if (response.data && response.data.success) {
            // Deduct from Firebase
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-amount),
                todayWithdrawals: admin.firestore.FieldValue.increment(1),
                lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp()
            });

            // Create a record in withdrawals collection
            await db.collection('withdrawals').add({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                fee: amount * 0.4,
                receivingAmount: netAmount,
                status: 'paid',
                date: admin.firestore.FieldValue.serverTimestamp(),
                transferId: response.data.data?.transferId || 'N/A'
            });

            return res.json({ success: true, transferId: response.data.data?.transferId });
        } else {
            return res.status(400).json({ error: response.data.error?.message || "xRocket Transfer Failed" });
        }

    } catch (err) {
        // This is where "Insufficient Balance" (from xRocket wallet) is caught
        console.error("Withdrawal Error Log:", err.response?.data || err.message);
        
        const errorMessage = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        
        // Save failed attempt to Firestore for debugging
        if (db) {
            await db.collection('withdrawals').add({
                userId: String(userId),
                amount: amount,
                status: 'failed',
                error: errorMessage,
                date: admin.firestore.FieldValue.serverTimestamp()
            }).catch(()=>{});
        }

        res.status(500).json({ error: errorMessage });
    }
});

// --- 4. START SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
