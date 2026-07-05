require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const pino = require('pino');

// Setup Logger
const log = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Variables
const PORT = process.env.PORT || 3000;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = 'https://pay.xrocket.exchange';
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const API_SECRET = process.env.API_SECRET || 'your-secure-secret';
const DAILY_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 100000);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'watchdog_autopay';

if (!XROCKET_API_KEY || !MONGODB_URI) {
  log.error('❌ Missing Critical Variables: XROCKET_API_KEY or MONGODB_URI');
  process.exit(1);
}

// ===== MONGODB CONNECTION =====
let db, balances, transactions;

async function connectMongo() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB);
    balances = db.collection('balances');
    transactions = db.collection('transactions');

    await balances.createIndex({ userId: 1 }, { unique: true });
    await transactions.createIndex({ transferId: 1 }, { unique: true });
    log.info('🍃 MongoDB Connected');
  } catch (err) {
    log.error('❌ MongoDB Connection Failed', err);
    process.exit(1);
  }
}

// ===== HELPERS =====
async function getBalance(userId) {
  const doc = await balances.findOne({ userId: String(userId) });
  return doc ? doc.balance : 0;
}

async function dailyWithdrawn(userId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const result = await transactions.aggregate([
    { $match: { userId: String(userId), status: 'completed', createdAt: { $gt: since } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray();
  return result.length > 0 ? result[0].total : 0;
}

function authMiddleware(req, res, next) {
  const key = req.header('X-API-Key');
  if (key !== API_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { success: false, error: 'Too many requests. Wait 1 minute.' }
});

// ===== xRocket API Helper (FIXED) =====
async function callXRocketTransfer(payload) {
  try {
    // ✅ FIX #1: Use full /api/v1/app/transfer path
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
    return {
      ok: false,
      error: err.response?.data?.message || err.message
    };
  }
}

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.json({ status: 'Live', service: 'xRocket-to-xRocket Autopay', fee: `${FEE_PERCENT}%` });
});

app.get('/balance/:userId', authMiddleware, async (req, res) => {
  const balance = await getBalance(req.params.userId);
  res.json({ userId: req.params.userId, balance });
});

app.post('/balance/:userId/add', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  await balances.updateOne(
    { userId: String(req.params.userId) },
    { $inc: { balance: Number(amount) }, $set: { updatedAt: Date.now() } },
    { upsert: true }
  );

  const newBal = await getBalance(req.params.userId);
  res.json({ success: true, newBalance: newBal });
});

// ===== Withdrawal Route (FIXED) =====
app.post('/withdraw', authMiddleware, withdrawLimiter, async (req, res) => {
  const { userId, telegramId, amount, currency = 'DOGS' } = req.body;

  if (!userId || !telegramId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // 1. Check DB Balance
  const balance = await getBalance(userId);
  if (balance < amount) {
    return res.status(400).json({ success: false, error: 'Insufficient balance' });
  }

  // 1b. Check Daily Limit
  const alreadyToday = await dailyWithdrawn(userId);
  if (alreadyToday + amount > DAILY_LIMIT) {
    return res.status(400).json({
      success: false,
      error: `Daily limit exceeded. Limit: ${DAILY_LIMIT}, already: ${alreadyToday}`
    });
  }

  // 2. Setup Transfer Details
  const fee = (amount * FEE_PERCENT) / 100;
  const netAmount = Number((amount - fee).toFixed(2));
  const transferId = crypto.randomUUID();

  // 3. Atomic Deduction
  const deduct = await balances.updateOne(
    { userId: String(userId), balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { updatedAt: Date.now() } }
  );

  if (deduct.matchedCount === 0) {
    return res.status(400).json({ success: false, error: 'Deduction failed (check balance)' });
  }

  // 4. Log Pending Transaction
  await transactions.insertOne({
    userId, transferId, telegramId, amount, fee, net: netAmount,
    currency, status: 'pending', createdAt: Date.now()
  });

  log.info(`🚀 Attempting transfer: ${netAmount} ${currency} to ${telegramId}`);

  // 5. Call xRocket — ✅ FIX #2: Use correct field names from docs
  const result = await callXRocketTransfer({
    toUserId: Number(telegramId),     // ✅ was wrong: tgUserId
    currency: currency,
    amount: netAmount,
    transferId: transferId,
    description: `Watch Dog payout for ${userId}`
  });

  if (result.ok) {
    await transactions.updateOne({ transferId }, { $set: { status: 'completed', completedAt: Date.now() } });
    log.info(`✅ Transfer Success: ${transferId}`);
    return res.json({
      success: true,
      transferId,
      withdrawn: amount,
      fee,
      net: netAmount,
      currency
    });
  } else {
    // Fail & Refund
    await balances.updateOne({ userId: String(userId) }, { $inc: { balance: amount } });
    await transactions.updateOne({ transferId }, { $set: { status: 'failed', error: result.error } });
    log.error(`❌ xRocket Failed: ${result.error} - Refunded user.`);
    return res.status(502).json({ success: false, error: result.error, refunded: true });
  }
});

// ===== START SERVER =====
connectMongo().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    log.info(`🚀 Autopay running on port ${PORT}`);
  });
});
