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
app.use(cors()); // Allows your Mini App to talk to this server
app.use(express.json());

const PORT = process.env.PORT || 3000;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = 'https://pay.xrocket.exchange'; // Official URL
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const DAILY_WITHDRAW_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 100000);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'watchdog_autopay';

// Security check on startup
if (!XROCKET_API_KEY || !MONGODB_URI) {
  log.error('❌ CRITICAL ERROR: Missing XROCKET_API_KEY or MONGODB_URI in Railway Variables');
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
    
    log.info('🍃 MongoDB connected and Indexes created');
  } catch (err) {
    log.error('❌ MongoDB Connection Failed:', err.message);
    process.exit(1);
  }
}

// ===== HELPERS =====
async function getBalance(userId) {
  const doc = await balances.findOne({ userId });
  return doc ? doc.balance : 0;
}

// Atomic update to prevent double-spending
async function deductBalance(userId, amount) {
  const result = await balances.updateOne(
    { userId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { updatedAt: Date.now() } }
  );
  return result.matchedCount > 0;
}

async function refundBalance(userId, amount) {
  await balances.updateOne(
    { userId },
    { $inc: { balance: amount }, $set: { updatedAt: Date.now() } }
  );
}

// Official xRocket API Call logic
async function callXRocketTransfer(tgUserId, amount, currency, transferId) {
  try {
    const res = await axios.post(`${XROCKET_BASE_URL}/app/transfer`, {
      tgUserId: Number(tgUserId),
      currency: currency,
      amount: Number(amount),
      transferId: transferId,
      description: `Withdrawal for User ${tgUserId}`
    }, {
      headers: {
        'Rocket-Pay-Key': XROCKET_API_KEY, // Use the correct Header
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return { ok: true, data: res.data };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

// ===== ROUTES =====

// 1. Health Check
app.get('/', (req, res) => {
  res.json({ status: 'Live', service: 'xRocket Auto-Pay', fee: `${FEE_PERCENT}%` });
});

// 2. Withdrawal Route
app.post('/api/withdraw', async (req, res) => {
  const { userId, tgUserId, amount, currency = 'DOGS' } = req.body;

  // Basic Validation
  if (!userId || !tgUserId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // Check Database Balance
  const currentBalance = await getBalance(userId);
  if (currentBalance < amount) {
    return res.status(400).json({ success: false, error: 'Insufficient balance' });
  }

  const fee = (amount * FEE_PERCENT) / 100;
  const netAmount = amount - fee;
  const transferId = crypto.randomUUID();

  // Try to deduct balance first (Atomic)
  const success = await deductBalance(userId, amount);
  if (!success) {
    return res.status(400).json({ success: false, error: 'Balance deduction failed' });
  }

  // Create Pending Transaction record
  await transactions.insertOne({
    userId, transferId, tgUserId, amount, netAmount, status: 'pending', createdAt: Date.now()
  });

  log.info(`🚀 Starting transfer: ${netAmount} ${currency} to TG:${tgUserId}`);

  // Call xRocket
  const result = await callXRocketTransfer(tgUserId, netAmount, currency, transferId);

  if (result.ok) {
    await transactions.updateOne({ transferId }, { $set: { status: 'completed' } });
    log.info(`✅ Success: ${transferId}`);
    return res.json({ success: true, transferId, net: netAmount });
  } else {
    // REFUND the user if xRocket fails
    await refundBalance(userId, amount);
    await transactions.updateOne({ transferId }, { $set: { status: 'failed', error: result.error } });
    log.error(`❌ xRocket Failed: ${result.error} — Refunded User.`);
    return res.status(502).json({ success: false, error: result.error, refunded: true });
  }
});

// 3. User Balance check (for frontend)
app.get('/api/user/:userId', async (req, res) => {
  const balance = await getBalance(req.params.userId);
  res.json({ userId: req.params.userId, balance });
});

// ===== START SERVER =====
connectMongo().then(() => {
  // Bind to 0.0.0.0 to fix Railway SIGTERM error
  app.listen(PORT, "0.0.0.0", () => {
    log.info(`🚀 Server running on port ${PORT}`);
  });
});
