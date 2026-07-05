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

// --- CONNECT TO FIREBASE ---
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  log.error('❌ Missing FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- CONFIG ---
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = 'https://pay.xrocket.exchange';
const API_SECRET = process.env.API_SECRET;
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const DAILY_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 100000);
const SUPPORTED_CURRENCIES = ['DOGS', 'TONCOIN', 'NOTCOIN'];

if (!XROCKET_API_KEY || !API_SECRET) {
  log.error('❌ Missing XROCKET_API_KEY or API_SECRET');
  process.exit(1);
}

// --- HELPERS ---
function authMiddleware(req, res, next) {
  const key = req.header('X-API-Key');
  if (key !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { success: false, error: 'Too many requests. Wait 1 minute.' }
});

async function callXRocketTransfer(payload) {
  try {
    // ✅ FIX #1: Correct full path
    const res = await axios.post(`${XROCKET_BASE_URL}/api/v1/app/transfer`, payload, {
      headers: {
        'Rocket-Pay-Key': XROCKET_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return { ok: true, data: res.data };
  } catch (err) {
    log.error({ err: err.response?.data || err.message }, 'xRocket failed');
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

async function getDailyWithdrawn(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const snapshot = await db.collection('withdrawals')
    .where('userId', '==', userId)
    .where('status', '==', 'completed')
    .where('createdAt', '>', since)
    .get();
  let total = 0;
  snapshot.forEach(doc => {
    total += doc.data().amount || 0;
  });
  return total;
}

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.json({
    status: 'Live',
    service: 'Firebase xRocket Auto-Pay',
    fee: `${FEE_PERCENT}%`,
    database: 'firebase'
  });
});

app.get('/balance/:userId', authMiddleware, async (req, res) => {
  const userRef = db.collection('users').doc(req.params.userId);
  const doc = await userRef.get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  const balance = doc.data().usdtBalance || 0;
  res.json({ userId: req.params.userId, balance });
});

// ===== MAIN WITHDRAWAL ENDPOINT =====
app.post('/withdraw', authMiddleware, withdrawLimiter, async (req, res) => {
  const { userId, telegramId, amount, currency = 'DOGS' } = req.body;

  // 1. Validation
  if (!userId || !telegramId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing userId, telegramId, or amount' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Amount must be a positive number' });
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return res.status(400).json({ success: false, error: `Unsupported currency. Use: ${SUPPORTED_CURRENCIES.join(', ')}` });
  }

  try {
    // 2. Check Firebase balance
    const userRef = db.collection('users').doc(String(userId));
    const doc = await userRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'User not found in Firebase' });
    }

    const userData = doc.data();
    const currentBalance = userData.usdtBalance || 0;

    if (currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient balance. You have ${currentBalance}, need ${amount}` 
      });
    }

    // 3. Check daily limit
    const alreadyToday = await getDailyWithdrawn(String(userId));
    if (alreadyToday + amount > DAILY_LIMIT) {
      return res.status(400).json({
        success: false,
        error: `Daily limit exceeded. Limit: ${DAILY_LIMIT}, already withdrawn: ${alreadyToday}`
      });
    }

    // 4. Calculate fee
    const fee = (amount * FEE_PERCENT) / 100;
    const netAmount = Number((amount - fee).toFixed(2));
    const transferId = `wd_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // 5. Atomic deduction (check balance again to prevent race conditions)
    const deductResult = await userRef.update({
      usdtBalance: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 6. Log pending withdrawal
    await db.collection('withdrawals').doc(transferId).set({
      userId: String(userId),
      transferId,
      telegramId: String(telegramId),
      amount,
      fee,
      net: netAmount,
      currency,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    log.info({ userId, amount, fee, netAmount, currency, transferId }, '🚀 Transfer started');

    // 7. Call xRocket — ✅ FIX #2: Use correct field name
    const result = await callXRocketTransfer({
      toUserId: Number(telegramId),     // ✅ was tgUserId (wrong)
      currency: currency,
      amount: netAmount,
      transferId: transferId,
      description: `Watch Dog payout for ${userId}`  // ✅ required field
    });

    if (result.ok) {
      // Success
      await db.collection('withdrawals').doc(transferId).update({
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        xrocketResponse: result.data
      });
      log.info({ transferId, userId, netAmount }, '✅ Transfer completed');
      return res.json({
        success: true,
        message: 'Transfer sent instantly via xRocket',
        transferId,
        withdrawn: amount,
        fee,
        net: netAmount,
        currency
      });
    } else {
      // Fail — REFUND the user
      await userRef.update({
        usdtBalance: admin.firestore.FieldValue.increment(amount)
      });
      await db.collection('withdrawals').doc(transferId).update({
        status: 'failed',
        error: result.error,
        failedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      log.error({ transferId, err: result.error }, '❌ Transfer failed — refunded');
      return res.status(502).json({
        success: false,
        error: 'Transfer failed. Amount refunded.',
        details: result.error,
        refunded: true,
        transferId
      });
    }
  } catch (err) {
    log.error({ err: err.message }, 'Withdrawal error');
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  log.info(`🚀 Server running on port ${PORT}`);
});
