require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONNECT TO FIREBASE USING SERVICE ACCOUNT ---
// This variable comes from your Railway "Variables" tab
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- CONFIG ---
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;
const FEE_PERCENT = 40;

// --- WITHDRAW ROUTE ---
app.post('/withdraw', async (req, res) => {
  const { userId, telegramId, amount } = req.body;
  const clientKey = req.header('X-API-Key');

  // 1. Security Check: Only your app can call this
  if (clientKey !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    // 2. CHECK FIREBASE BALANCE
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'User not found in Firebase' });
    }

    const userData = doc.data();
    const currentBalance = userData.usdtBalance || 0; // FIELD NAME FROM YOUR FIREBASE

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: `Insufficient Balance. You have ${currentBalance} DOGS` });
    }

    // 3. CALCULATE PAYOUT (Minus 40% Fee)
    const netAmount = amount - (amount * FEE_PERCENT / 100);

    // 4. CALL XROCKET
    const xrocketRes = await axios.post('https://pay.xrocket.exchange/app/transfer', {
      tgUserId: Number(telegramId),
      currency: 'DOGS',
      amount: Number(netAmount.toFixed(2)),
      transferId: `wd_${Date.now()}`,
      description: `Watch Dog Payout`
    }, {
      headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
    });

    // 5. UPDATE FIREBASE (Subtract the balance)
    await userRef.update({
      usdtBalance: admin.firestore.FieldValue.increment(-amount)
    });

    res.json({ 
      success: true, 
      message: 'Transfer successful! Firebase balance updated.',
      transferId: xrocketRes.data.data?.transferId || 'ok'
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ 
      success: false, 
      error: err.response?.data?.message || err.message 
    });
  }
});

app.get('/', (req, res) => res.send("Firebase Payout Server Live 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
