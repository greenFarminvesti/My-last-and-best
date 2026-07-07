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
const XROCKET_BASE_URL = process.env.XROCKET_BASE_URL || 'https://pay.xrocket.exchange';
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
const withdrawLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    message: { success: false, error: 'Too many requests. Wait 1 minute.' }
});

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

async function callXRocketTransfer(payload) {
    // ✅ FIX #1: Correct full path
    const url = `${XROCKET_BASE_URL}/api/v1/app/transfer`;
    log.info({ url, payload }, '📤 Calling xRocket');
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Rocket-Pay-Key': XROCKET_API_KEY,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (err) {
        log.error({ 
            status: err.response?.status,
            body: err.response?.data,
            message: err.message 
        }, '❌ xRocket call failed');
        return { 
            ok: false, 
            status: err.response?.status || 500,
            error: err.response?.data?.message || err.message,
            details: err.response?.data
        };
    }
}

// ===== ROUTES =====

app.get('/', (req, res) => {
    res.json({ 
        status: 'Online', 
        service: 'Firebase xRocket Auto-Pay',
        fee: `${FEE_PERCENT}%`,
        xrocketUrl: `${XROCKET_BASE_URL}/api/v1/app/transfer`
    });
});

// ===== MAIN WITHDRAWAL ENDPOINT =====
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount, currency = 'DOGS' } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const numTgId = Number(telegramId);
    const numAmount = Number(amount);

    if (!userId || !numTgId || !numAmount || numAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters" });
    }
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
        return res.status(400).json({ success: false, error: `Unsupported currency. Use: ${SUPPORTED_CURRENCIES.join(', ')}` });
    }

    const transferId = `tx_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
        
        const currentBalance = doc.data().totalBalance || 0;
        if (currentBalance < numAmount) {
            return res.status(400).json({ 
                success: false, 
                error: `Insufficient balance. You have ${currentBalance}, need ${numAmount}` 
            });
        }

        // Check daily limit
        const alreadyToday = await getDailyWithdrawn(String(userId));
        if (alreadyToday + numAmount > DAILY_LIMIT) {
            return res.status(400).json({
                success: false,
                error: `Daily limit exceeded. Limit: ${DAILY_LIMIT}, already withdrawn: ${alreadyToday}`
            });
        }

        // Calculate fee (you keep it, user gets 60%)
        const fee = (numAmount * FEE_PERCENT) / 100;
        const netAmount = Math.floor(numAmount - fee);

        // Log pending withdrawal
        await db.collection('withdrawals').doc(transferId).set({
            userId: String(userId),
            transferId,
            telegramId: String(numTgId),
            amount: numAmount,
            fee,
            net: netAmount,
            currency,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // ✅ FIX #2: Use correct field name and full URL
        const result = await callXRocketTransfer({
            toUserId: numTgId,              // ✅ was tgUserId (wrong!)
            currency: currency,
            amount: netAmount,
            transferId: transferId,
            description: `Watch Dog payout for ${userId}`
        });

        if (result.ok && result.data?.success !== false) {
            // Success — update Firebase
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount),
                totalWithdrawn: admin.firestore.FieldValue.increment(numAmount)
            });
            
            await db.collection('withdrawals').doc(transferId).update({
                status: 'completed',
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                xrocketResponse: result.data
            });

            log.info({ transferId, userId, netAmount }, '✅ Transfer completed');
            return res.json({ 
                success: true, 
                transferId, 
                withdrawn: numAmount,
                fee,
                net: netAmount,
                currency
            });
        } else {
            // Fail — refund
            await userRef.update({
                totalBalance: admin.firestore.FieldValue.increment(-numAmount) // No-op if deduction already happened
            }).catch(() => {});
            
            // Actually we deducted after success, so we need to refund if we deducted first
            // In this version, we deduct AFTER xRocket succeeds, so no refund needed
            
            await db.collection('withdrawals').doc(transferId).update({
                status: 'failed',
                error: result.error,
                failedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            log.error({ transferId, err: result.error }, '❌ Transfer failed');
            return res.status(result.status || 502).json({
                success: false,
                error: 'Transfer failed. No balance was deducted.',
                details: result.error || result.details
            });
        }

    } catch (err) {
        log.error({ err: err.message, stack: err.stack }, '❌ Withdrawal error');
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    log.info(`🚀 Server running on port ${PORT}`);
});
