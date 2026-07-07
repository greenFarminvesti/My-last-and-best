require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const pino = require('pino');

const log = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// --- 1. FIREBASE ADMIN INIT ---
try {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        log.info("✅ Firebase Connected");
    }
} catch (e) {
    log.error({ err: e.message }, "❌ Firebase Error");
    process.exit(1);
}

const db = admin.firestore();
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
// Updated to the most stable production domain
const XROCKET_BASE_URL = 'https://pay.xrocket.tg'; 
const API_SECRET = process.env.API_SECRET;
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const DAILY_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 100000);
const SUPPORTED_CURRENCIES = ['DOGS', 'TONCOIN', 'NOTCOIN'];
const PORT = process.env.PORT || 3000;

if (!XROCKET_API_KEY || !API_SECRET) {
    log.error('❌ Missing XROCKET_API_KEY or API_SECRET');
    process.exit(1);
}

// --- HELPERS ---
async function getDailyWithdrawn(userId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snapshot = await db.collection('withdrawals')
        .where('userId', '==', String(userId))
        .where('status', '==', 'completed')
        .where('createdAt', '>', since)
        .get();
    let total = 0;
    snapshot.forEach(doc => {
        total += doc.data().amount || 0;
    });
    return total;
}

// ===== MAIN WITHDRAWAL ENDPOINT =====
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount, currency = 'DOGS' } = req.body;
    const auth = req.header('X-API-Key');

    // 1. Authorization
    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    // 2. Validation
    if (!userId || !numTgId || !numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters" });
    }
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
        return res.status(400).json({ success: false, error: `Unsupported currency` });
    }

    const transferId = `tx_${userId}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) return res.status(404).json({ success: false, error: "User not found" });
        
        const currentBalance = doc.data().totalBalance || 0;
        if (currentBalance < numAmount) {
            return res.status(400).json({ success: false, error: "Insufficient balance" });
        }

        // 3. Daily Limit Check
        const alreadyToday = await getDailyWithdrawn(String(userId));
        if (alreadyToday + numAmount > DAILY_LIMIT) {
            return res.status(400).json({ success: false, error: "Daily limit exceeded" });
        }

        const fee = (numAmount * FEE_PERCENT) / 100;
        const netAmount = Math.floor(numAmount - fee);

        // 4. xRocket Transfer Call
        // FIX: Using /api/transfer and tgUserId
        const xrocketUrl = `${XROCKET_BASE_URL}/api/transfer`;
        const payload = {
            tgUserId: numTgId, 
            currency: currency,
            amount: netAmount,
            transferId: transferId,
            description: `Withdrawal for ${userId}`
        };

        log.info({ url: xrocketUrl, payload }, "📤 Requesting xRocket Transfer");

        const response = await axios.post(xrocketUrl, payload, {
            headers: {
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });

        // 5. Handle Success
        if (response.data && response.data.success) {
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });
            
            await db.collection('withdrawals').doc(transferId).set({
                userId: String(userId),
                telegramId: numTgId,
                amount: numAmount,
                net: netAmount,
                status: 'completed',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({ success: true, transferId, net: netAmount });
        } else {
            throw new Error(response.data?.message || "Transfer rejected");
        }

    } catch (err) {
        const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
        const statusCode = err.response?.status || 500;

        log.error({ 
            status: statusCode, 
            details: err.response?.data 
        }, "❌ Withdrawal Failed");

        return res.status(statusCode).json({
            success: false,
            error: "Transfer failed",
            details: errorMsg
        });
    }
});

app.get('/', (req, res) => res.json({ status: 'Online' }));

app.listen(PORT, "0.0.0.0", () => {
    log.info(`🚀 Server running on port ${PORT}`);
});
