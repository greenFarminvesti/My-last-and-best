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
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        console.log("✅ Firebase Admin Initialized");
    }
} catch (e) {
    console.error("❌ Firebase Initialization Failed:", e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        firebase: db ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header("X-API-Key");

    if (auth !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!db) {
        return res.status(500).json({ error: "Firebase not connected" });
    }

    try {
        const userRef = db.collection("users").doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const balance = Number(doc.data().totalBalance || 0);

        console.log("Withdrawal Request");
        console.log({
            userId,
            telegramId,
            amount,
            balance
        });

        if (balance < amount) {
            return res.status(400).json({
                error: "Insufficient balance in app"
            });
        }

        if (!telegramId || isNaN(Number(telegramId))) {
            return res.status(400).json({
                error: "Invalid Telegram ID",
                telegramId
            });
        }

        const netAmount = Number((amount * 0.6).toFixed(2));

        const response = await axios.post(
            "https://pay.xrocket.tg/app/transfer",
            {
                tgUserId: Number(telegramId),
                currency: "DOGS",
                amount: netAmount,
                transferId: `wd_${Date.now()}`,
                description: `Withdrawal for User ${userId}`
            },
            {
                headers: {
                    "Rocket-Pay-Key": XROCKET_API_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("xRocket Success:");
        console.dir(response.data, { depth: null });

        await userRef.update({
            totalBalance: admin.firestore.FieldValue.increment(-amount),
            todayWithdrawals: admin.firestore.FieldValue.increment(1),
            lastWithdrawalDate: admin.firestore.FieldValue.serverTimestamp()
        });

        await db.collection("withdrawals").add({
            userId: String(userId),
            telegramId: Number(telegramId),
            amount,
            fee: amount * 0.4,
            receivingAmount: netAmount,
            status: "paid",
            transferId: response.data.data?.transferId || null,
            date: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            success: true,
            transferId: response.data.data?.transferId || null
        });

    } catch (err) {

        console.log("========== XROCKET ERROR ==========");
        console.log("Status:", err.response?.status);
        console.dir(err.response?.data, { depth: null });
        console.log("Message:", err.message);
        console.log("===================================");

        const errorMessage =
            err.response?.data?.error?.message ||
            err.response?.data?.message ||
            JSON.stringify(err.response?.data) ||
            err.message;

        try {
            await db.collection("withdrawals").add({
                userId: String(userId),
                telegramId,
                amount,
                status: "failed",
                error: errorMessage,
                date: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {}

        return res.status(500).json({
            error: errorMessage
        });
    }
});
