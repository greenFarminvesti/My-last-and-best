require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = 'https://pay.xrocket.exchange';
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'watchdog_autopay';
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(cors()); // Critical for your Mini App to connect
app.use(express.json());

// Rate limiting to prevent spam
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10 // limit each IP to 10 requests per windowMs
});
app.use('/api/withdraw', limiter);

// --- Database Connection ---
let db, balances, transactions;

async function connectMongo() {
  try {
    if (!MONGODB_URI) throw new Error("MONGODB_URI is missing in Variables");
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB);
    balances = db.collection('balances');
    transactions = db.collection('transactions');

    // Create Indexes for speed and security
    await balances.createIndex({ userId: 1 }, { unique: true });
    await transactions.createIndex({ transferId: 1 }, { unique: true });

    console.log('✅ MongoDB Connected and Ready');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    // Don't exit immediately, let Railway try to restart
  }
}

// --- xRocket API Helper ---
async function callXRocketTransfer(tgUserId, amount, currency, transferId) {
  try {
    const res = await axios.post(`${XROCKET_BASE_URL}/app/transfer`, {
      tgUserId: Number(tgUserId),
      currency: currency,
      amount: Number(amount),
      transferId: transferId,
      description: `Withdrawal for TG ID: ${tgUserId}`
    }, {
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

// --- Routes ---

// 1. Health Check
app.get('/', (req, res) => {
  res.json({ status: 'Online', service: 'xRocket Auto-Pay', fee: `${FEE_PERCENT}%` });
});

// 2. Get User Balance
app.get('/api/user/:userId', async (req, res) => {
  try {
    const doc = await balances.findOne({ userId: req.params.userId });
    res.json({ userId: req.params.userId, balance: doc ? doc.balance : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. The Withdrawal Logic
app.post('/api/withdraw', async (req, res) => {
  const { userId, tgUserId, amount, currency = 'DOGS' } = req.body;

  // Validation
  if (!userId || !tgUserId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  if (!XROCKET_API_KEY) {
    return res.status(500).json({ success: false, error: 'Server API Key not configured' });
  }

  try {
    // Check current balance
    const userDoc = await balances.findOne({ userId });
    const currentBalance = userDoc ? userDoc.balance : 0;

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    const fee = (amount * FEE_PERCENT) / 100;
    const netAmount = amount - fee;
    const transferId = crypto.randomUUID();

    // Step 1: Atomic Deduction (Prevents double spending)
    const deduct = await balances.updateOne(
      { userId, balance: { $gte: amount } },
      { $inc: { balance: -amount }, $set: { updatedAt: Date.now() } }
    );

    if (deduct.matchedCount === 0) {
      return res.status(400).json({ success: false, error: 'Balance deduction failed' });
    }

    // Step 2: Record Pending Transaction
    await transactions.insertOne({
      userId, transferId, tgUserId, amount, netAmount, status: 'pending', createdAt: Date.now()
    });

    console.log(`🚀 Sending ${netAmount} ${currency} to TG:${tgUserId}`);

    // Step 3: Call xRocket
    const result = await callXRocketTransfer(tgUserId, netAmount, currency, transferId);

    if (result.ok) {
      // Success
      await transactions.updateOne({ transferId }, { $set: { status: 'completed', completedAt: Date.now() } });
      console.log(`✅ Payout Successful: ${transferId}`);
      return res.json({ success: true, transferId, net: netAmount });
    } else {
      // Failure - REFUND the user
      await balances.updateOne({ userId }, { $inc: { balance: amount } });
      await transactions.updateOne({ transferId }, { $set: { status: 'failed', error: result.error } });
      console.error(`❌ xRocket Failed: ${result.error}. Amount refunded.`);
      return res.status(502).json({ success: false, error: result.error, refunded: true });
    }

  } catch (err) {
    console.error('System Error:', err.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// --- Start Server ---
connectMongo().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
