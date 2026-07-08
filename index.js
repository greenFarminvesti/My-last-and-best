require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const XROCKET_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

mongoose.connect(MONGODB_URI).then(() => console.log("✅ MongoDB Only Mode Active"));

// --- USER MODEL ---
const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true, required: true },
    telegramId: { type: Number },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null }
}, { strict: false });

const User = mongoose.model('User', userSchema);

// --- ROUTES ---

// 1. NEW USER / SYNC ROUTE
// Call this whenever a user opens the app or their balance changes
app.post('/sync-user', async (req, res) => {
    const { userId, telegramId, balance } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        // This "upsert" command finds the user and updates them. 
        // If they don't exist, it CREATES them automatically.
        const user = await User.findOneAndUpdate(
            { userId: String(userId) },
            { 
                $set: { 
                    telegramId: telegramId,
                    totalBalance: balance // Updates balance to match what's in the app
                } 
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, message: "User synced to MongoDB", user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. WITHDRAW ROUTE
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        const user = await User.findOne({ userId: String(userId) });
        
        // If user isn't in DB yet, we try to create them with 0 balance first 
        // to prevent the 404 error.
        if (!user) {
            return res.status(404).json({ error: "User not synced. Please open the app first." });
        }

        if (user.totalBalance < amount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        const netAmount = Number((amount * 0.6).toFixed(2));

        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: `wd_${Date.now()}`,
            description: "Dogs Withdrawal"
        }, {
            headers: { 'Rocket-Pay-Key': XROCKET_KEY, 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.success) {
            await User.findOneAndUpdate(
                { userId: String(userId) },
                { 
                    $inc: { totalBalance: -amount, todayWithdrawals: 1 },
                    $set: { lastWithdrawalDate: new Date() }
                }
            );
            return res.json({ success: true });
        } else {
            return res.status(400).json({ error: "xRocket Error" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', async (req, res) => {
    const count = await User.countDocuments();
    res.json({ status: "MongoDB Only", users_in_db: count });
});

app.listen(PORT, "0.0.0.0");
