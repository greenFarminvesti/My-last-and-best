require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const Database = require('better-sqlite3');
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
const XROCKET_BASE_URL = process.env.XROCKET_BASE_URL || 'https://pay.testnet.xrocket.exchange';
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const API_SECRET = process.env.API_SECRET || 'change-me-in-railway';
const TEST_MODE = process.env.TEST_MODE === 'true';
const DAILY_WITHDRAW_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 10000);
const SUPPORTED_CURRENCIES = ['TONCOIN', 'DOGS', 'NOTCOIN'];

if (!XROCKET_API_KEY) {
  log.error('❌ Missing XROCKET_API_KEY');
  process.exit(1);
}

// ===== DATABASE =====
const db = new Database('autopay.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS balances (
    userId TEXT PRIMARY KEY,
    balance REAL NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    transferId TEXT UNIQUE NOT NULL,
    telegramId INTEGER NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL,
    net REAL NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    description TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(userId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
`);

const stmtGetBalance = db.prepare('SELECT balance FROM balances WHERE userId = ?');
const stmtSetBalance = db.prepare(`
  INSERT INTO balances (userId, balance, updatedAt) VALUES (?, ?, ?)
  ON CONFLICT(userId) DO UPDATE SET balance = excluded.balance, updatedAt = excluded.updatedAt
`);
const stmtAddTx = db.prepare(`
  INSERT INTO transactions (userId, transferId, telegramId, amount, fee, net, currency, status, description, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateTx = db.prepare('UPDATE transactions SET status = ? WHERE transferId = ?');
const stmtGetTx = db.prepare('SELECT * FROM transactions WHERE transferId = ?');
const stmtListTx = db.prepare(`
  SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT ?
`);
const stmtDailySum = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
  WHERE userId = ? AND createdAt > ? AND status = 'completed'
`);

// ===== HELPERS =====
function generateTransferId() {
  return `wd_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function getBalance(userId) {
  const row = stmtGetBalance.get(userId);
  return row ? row.balance : 0;
}

function setBalance(userId, balance) {
  stmtSetBalance.run(userId, balance, Date.now());
}

function addToBalance(userId, amount) {
  const current = getBalance(userId);
  setBalance(userId, current + amount);
}

function dailyWithdrawn(userId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return stmtDailySum.get(userId, since).total;
}

async function callXRocket(endpoint, payload) {
  if (TEST_MODE) {
    log.warn('🧪 TEST_MODE active — faking xRocket success');
    return { ok: true, data: { ...payload, status: 'completed' } };
  }
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

// Health
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'xrocket-instant-autopay',
    version: '2.0.0',
    fee: `${FEE_PERCENT}%`,
    testMode: TEST_MODE,
    currencies: SUPPORTED_CURRENCIES
  });
});

// Get balance
app.get('/balance/:userId', authMiddleware, (req, res) => {
  res.json({ userId: req.params.userId, balance: getBalance(req.params.userId) });
});

// Add funds (admin / payment confirmed)
app.post('/balance/:userId/add', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }
  addToBalance(req.params.userId, amount);
  const newBalance = getBalance(req.params.userId);
  log.info({ userId: req.params.userId, amount, newBalance }, 'Balance added');
  res.json({ success: true, newBalance });
});

// Instant auto-pay withdrawal
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

  const balance = getBalance(userId);
  if (balance < amount) {
    return res.status(400).json({ success: false, error: `Insufficient balance. You have ${balance}, need ${amount}` });
  }

  const alreadyToday = dailyWithdrawn(userId);
  if (alreadyToday + amount > DAILY_WITHDRAW_LIMIT) {
    return res.status(400).json({
      success: false,
      error: `Daily limit exceeded. Limit: ${DAILY_WITHDRAW_LIMIT}, already withdrawn: ${alreadyToday}`
    });
  }

  const fee = (amount * FEE_PERCENT) / 100;
  const netAmount = amount - fee;
  const transferId = generateTransferId();

  setBalance(userId, balance - amount);
  stmtAddTx.run(
    userId, transferId, telegramId, amount, fee, netAmount,
    currency, 'pending', `Auto-Pay to ${telegramId}`, Date.now()
  );

  log.info({ userId, amount, fee, netAmount, currency, transferId }, 'Withdrawal started');

  const result = await callXRocket('/api/v1/withdrawals', {
    tgUserId: telegramId,
    currency: currency,
    amount: netAmount,
    transferId: transferId,
    description: `Watch Dog auto-pay for ${userId}`
  });

  if (result.ok) {
    stmtUpdateTx.run('completed', transferId);
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
  setBalance(userId, getBalance(userId) + amount);
  stmtUpdateTx.run('failed', transferId);

  log.error({ transferId, err: result.error }, '❌ Withdrawal failed — refunded');

  return res.status(502).json({
    success: false,
    error: 'Withdrawal failed. Amount refunded.',
    details: result.error,
    refunded: true,
    transferId
  });
});

// Get single transaction
app.get('/transaction/:transferId', authMiddleware, (req, res) => {
  const tx = stmtGetTx.get(req.params.transferId);
  if (!tx) return res.status(404).json({ success: false, error: 'Transaction not found' });
  res.json(tx);
});

// Transaction history
app.get('/transactions/:userId', authMiddleware, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const txs = stmtListTx.all(req.params.userId, limit);
  res.json({ userId: req.params.userId, count: txs.length, transactions: txs });
});

// xRocket webhook (for status updates)
app.post('/webhook/xrocket', (req, res) => {
  const { transferId, status } = req.body;
  if (!transferId || !status) {
    return res.status(400).json({ success: false, error: 'Missing transferId or status' });
  }
  stmtUpdateTx.run(status, transferId);
  log.info({ transferId, status }, 'Webhook update');
  res.json({ success: true });
});

// 404
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  log.info(`🚀 xRocket instant auto-pay running on port ${PORT}`);
  log.info(`💰 Fee: ${FEE_PERCENT}% | Test mode: ${TEST_MODE} | Currencies: ${SUPPORTED_CURRENCIES.join(', ')}`);
});
