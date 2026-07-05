require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const pino = require('pino');

const log = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = process.env.XROCKET_BASE_URL || 'https://pay.xrocket.exchange';
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const API_SECRET = process.env.API_SECRET || 'change-me-in-railway';
const DAILY_WITHDRAW_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 10000);
const SUPPORTED_CURRENCIES = ['TONCOIN', 'DOGS', 'NOTCOIN'];
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'watchdog_autopay';

if (!XROCKET_API_KEY) {
  log.error('❌ Missing XROCKET_API_KEY');
  process.exit(1);
}
if (!MONGODB_URI) {
  log.error('❌ Missing MONGODB_URI');
  process.exit(1);
}

// ===== MONGODB =====
let db;
let balances, transactions;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(MONGODB_DB);
  balances = db.collection('balances');
  transactions = db.collection('transactions');

  // Indexes for fast lookups
  await balances.createIndex({ userId: 1 }, { unique: true });
  await transactions.createIndex({ transferId: 1 }, { unique: true });
  await transactions.createIndex({ userId: 1, createdAt: -1 });
  await transactions.createIndex({ status: 1, createdAt: -1 });

  log.info('🍃 MongoDB connected');
}

// ===== HELPERS =====
function generateTransferId() {
  return `wd_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function getBalance(userId) {
  const doc = await balances.findOne({ userId });
  return doc ? doc.balance : 0;
}

async function setBalance(userId, balance) {
  await balances.updateOne(
    { userId },
    { $set: { userId, balance, updatedAt: Date.now() } },
    { upsert: true }
  );
}

async function addToBalance(userId, amount) {
  const current = await getBalance(userId);
  await setBalance(userId, current + amount);
}

async function dailyWithdrawn(userId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const result = await transactions.aggregate([
    {
      $match: {
        userId,
        status: 'completed',
        createdAt: { $gt: since }
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray();
  return result.length > 0 ? result[0].total : 0;
}

async function callXRocket(endpoint, payload) {
  try {
    const res = await axios.post(`${XROCKET_BASE_URL}${endpoint}`, payload, {
      headers: {
        'Authorization': `Bearer ${XROCKET_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return { ok: true, data: res.data };
  } catch (err) {
    log.error({ err: err.response?.data || err.message }, 'xRocket call failed');
    return { ok: false, status: err.response?.status || 500, error: err.response?.data || err.message };
  }
}

// ===== AUTH =====
function authMiddleware(req, res, next) {
  const key = req.header('X-API-Key');
  if (key !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ===== RATE LIMIT =====
const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, error: 'Too many withdrawal attempts. Try again in a minute.' }
});

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'xrocket-instant-autopay',
    version: '3.0.0',
    database: 'mongodb',
    fee: `${FEE_PERCENT}%`,
    currencies: SUPPORTED_CURRENCIES
  });
});

app.get('/balance/:userId', authMiddleware, async (req, res) => {
  const balance = await getBalance(req.params.userId);
  res.json({ userId: req.params.userId, balance });
});

app.post('/balance/:userId/add', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }
  await addToBalance(req.params.userId, amount);
  const newBalance = await getBalance(req.params.userId);
  log.info({ userId: req.params.userId, amount, newBalance }, 'Balance added');
  res.json({ success: true, newBalance });
});

app.post('/withdraw', authMiddleware, withdrawLimiter, async (req, res) => {
  const { userId, telegramId, amount, currency = 'TONCOIN' } = req.body;

  if (!userId || !telegramId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing userId, telegramId, or amount' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Amount must be a positive number' });
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return res.status(400).json({ success: false, error: `Unsupported currency. Use: ${SUPPORTED_CURRENCIES.join(', ')}` });
  }

  const balance = await getBalance(userId);
  if (balance < amount) {
    return res.status(400).json({ success: false, error: `Insufficient balance. You have ${balance}, need ${amount}` });
  }

  const alreadyToday = await dailyWithdrawn(userId);
  if (alreadyToday + amount > DAILY_WITHDRAW_LIMIT) {
    return res.status(400).json({
      success: false,
      error: `Daily limit exceeded. Limit: ${DAILY_WITHDRAW_LIMIT}, already withdrawn: ${alreadyToday}`
    });
  }

  const fee = (amount * FEE_PERCENT) / 100;
  const netAmount = amount - fee;
  const transferId = generateTransferId();

  // Atomic balance update (prevents race conditions)
  const updateResult = await balances.updateOne(
    { userId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { updatedAt: Date.now() } }
  );

  if (updateResult.matchedCount === 0) {
    return res.status(400).json({ success: false, error: 'Insufficient balance (concurrent update)' });
  }

  await transactions.insertOne({
    userId,
    transferId,
    telegramId,
    amount,
    fee,
    net: netAmount,
    currency,
    status: 'pending',
    description: `Auto-Pay to ${telegramId}`,
    createdAt: Date.now()
  });

  log.info({ userId, amount, fee, netAmount, currency, transferId }, 'Withdrawal started');

  const result = await callXRocket('/api/v1/withdrawals', {
    tgUserId: telegramId,
    currency: currency,
    amount: netAmount,
    transferId: transferId,
    description: `Watch Dog auto-pay for ${userId}`
  });

  if (result.ok) {
    await transactions.updateOne(
      { transferId },
      { $set: { status: 'completed', completedAt: Date.now() } }
    );
    log.info({ transferId, userId, netAmount }, '✅ Withdrawal completed');
    return res.json({
      success: true,
      message: 'Withdrawal sent instantly via xRocket',
      withdrawn: amount,
      fee,
      net: netAmount,
      currency,
      transferId
    });
  }

  // Refund on failure
  await balances.updateOne(
    { userId },
    { $inc: { balance: amount }, $set: { updatedAt: Date.now() } }
  );
  await transactions.updateOne(
    { transferId },
    { $set: { status: 'failed', failedAt: Date.now(), error: result.error } }
  );

  log.error({ transferId, err: result.error }, '❌ Withdrawal failed — refunded');

  return res.status(502).json({
    success: false,
    error: 'Withdrawal failed. Amount refunded.',
    details: result.error,
    refunded: true,
    transferId
  });
});

app.get('/transaction/:transferId', authMiddleware, async (req, res) => {
  const tx = await transactions.findOne({ transferId: req.params.transferId });
  if (!tx) return res.status(404).json({ success: false, error: 'Transaction not found' });
  res.json(tx);
});

app.get('/transactions/:userId', authMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const txs = await transactions
    .find({ userId: req.params.userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ userId: req.params.userId, count: txs.length, transactions: txs });
});

app.post('/webhook/xrocket', async (req, res) => {
  const { transferId, status } = req.body;
  if (!transferId || !status) {
    return res.status(400).json({ success: false, error: 'Missing transferId or status' });
  }
  await transactions.updateOne({ transferId }, { $set: { status, updatedAt: Date.now() } });
  log.info({ transferId, status }, 'Webhook update');
  res.json({ success: true });
});

// Stats endpoint (bonus!)
app.get('/stats', authMiddleware, async (req, res) => {
  const totalTx = await transactions.countDocuments({ status: 'completed' });
  const totalVolume = await transactions.aggregate([
    { $match: { status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' }, fees: { $sum: '$fee' } } }
  ]).toArray();
  const stats = totalVolume[0] || { total: 0, fees: 0 };
  res.json({
    totalTransactions: totalTx,
    totalVolume: stats.total,
    totalFees: stats.fees
  });
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

app.use((err, req, res, next) => {
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ===== START =====
connectMongo().then(() => {
  app.listen(PORT, () => {
    log.info(`🚀 xRocket instant auto-pay running on port ${PORT}`);
    log.info(`💰 Fee: ${FEE_PERCENT}% | Currencies: ${SUPPORTED_CURRENCIES.join(', ')}`);
  });
});
