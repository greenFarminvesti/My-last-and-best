require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();

// --- LOGGING ---
const log = {
  info: (msg) => console.log(`[INFO] ${JSON.stringify(msg)}`),
  error: (msg) => console.error(`[ERROR] ${JSON.stringify(msg)}`)
};

app.use(helmet());
app.use(cors());
app.use(express.json());

// --- CONNECT TO FIREBASE ---
try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT in Railway Variables');
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin Initialized');
} catch (err) {
    console.error('❌ Firebase Init Error:', err.message);
    process.exit(1); 
}

const db = admin.firestore();

// --- CONFIG ---
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const XROCKET_BASE_URL = 'https://pay.xrocket.exchange';
const API_SECRET = process.env.API_SECRET;
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 40);
const DAILY_LIMIT = Number(process.env.DAILY_WITHDRAW_LIMIT || 100000);

if (!XROCKET_API_KEY || !API_SECRET) {
  console.error('❌ Missing XROCKET_API_KEY or API_SECRET in Variables');
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

// Official xRocket Transfer Logic
async function callXRocketTransfer(payload) {
  try {
    const res = await axios.post(`${XROCKET_BASE_URL}/app/transfer`, payload, {
      headers: {
        'Rocket-Pay-Key': XROCKET_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return { ok: true, data: res.data };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

// --- ROUTES ---

app.get('/', (req, res) => {
  res.json({ status: 'Live', service: 'Firebase xRocket Payout', fee: `${FEE_PERCENT}%` });
});

app.post('/withdraw', authMiddleware, withdrawLimiter, async (req, res) => {
  const { userId, telegramId, amount, currency = 'DOGS' } = req.body;

  if (!userId || !telegramId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

  try {
    const userRef = db.collection('users').doc(String(userId));
    const doc = await userRef.get();

    if (!doc.exists) return res.status(404).json({ success: false, error: 'User not found' });

    const currentBalance = doc.data().usdtBalance || 0;
    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    const fee = (amount * FEE_PERCENT) / 100;
    const netAmount = Number((amount - fee).toFixed(2));
    const transferId = `wd_${Date.now()}`;

    // 1. Deduct from Firebase
    await userRef.update({
      usdtBalance: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 2. Call xRocket
    const result = await callXRocketTransfer({
      tgUserId: Number(telegramId), // xRocket uses tgUserId
      currency: currency,
      amount: netAmount,
      transferId: transferId,
      description: `Withdraw for ${userId}`
    });

    if (result.ok) {
      return res.json({ success: true, transferId, net: netAmount });
    } else {
      // 3. Refund if xRocket fails
      await userRef.update({ usdtBalance: admin.firestore.FieldValue.increment(amount) });
      return res.status(502).json({ success: false, error: result.error, refunded: true });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
