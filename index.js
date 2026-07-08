require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

app.use(cors());
app.use(express.json());

// --- MONGODB MODELS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    totalBalance: { type: Number, default: 0 },
    todayWithdrawals: { type: Number, default: 0 },
    lastWithdrawalDate: { type: Date, default: null }
});

const withdrawalSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    telegramId: { type: Number },
    amount: { type: Number, required: true },
    fee: { type: Number },
    receivingAmount: { type: Number },
    status: { type: String, enum: ['paid', 'failed'], required: true },
    date: { type: Date, default: Date.now },
    transferId: { type: String },
    error: { type: String }
});

const User = mongoose.model('User', userSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// --- DATABASE CONNECTION ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB Atlas Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- ROUTES ---

// Health Check
app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        database: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
        xrocket: XROCKET_API_KEY ? "Key Present" : "Key Missing"
    });
});

// Withdrawal Route
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    const auth = req.header('X-API-Key');

    // 1. Security & Validation
    if (auth !== API_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!userId || !telegramId || !amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid request parameters" });
    }

    try {
        // 2. Check User & Balance
        const user = await User.findOne({ userId: String(userId) });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.totalBalance < amount) {
            return res.status(400).json({ error: "Insufficient balance in App" });
        }

        // 3. Calculation Logic
        const netAmount = Number((amount * 0.6).toFixed(2));
        const feeAmount = Number((amount * 0.4).toFixed(2));
        const uniqueTransferId = `wd_${uuidv4()}`;

        console.log(`Processing: User ${userId} (${user.totalBalance}) withdrawing ${amount}`);

        // 4. Call xRocket API
        try {
            const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
                tgUserId: Number(telegramId),
                currency: 'DOGS', // Keeping your DOGS currency
                amount: netAmount,
                transferId: uniqueTransferId,
                description: `Withdrawal for User ${userId}`
            }, {
                headers: { 
                    'Rocket-Pay-Key': XROCKET_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            // 5. If Success: Update Database
            if (response.data && response.data.success) {
                
                // Atomic update to prevent race conditions
                await User.findOneAndUpdate(
                    { userId: String(userId) },
                    { 
                        $inc: { 
                            totalBalance: -amount, 
                            todayWithdrawals: 1 
                        },
                        $set: { lastWithdrawalDate: new Date() }
                    }
                );

                const withdrawalRecord = await Withdrawal.create({
                    userId: String(userId),
                    telegramId: Number(telegramId),
                    amount: amount,
                    fee: feeAmount,
                    receivingAmount: netAmount,
                    status: 'paid',
                    transferId: response.data.data?.transferId || uniqueTransferId
                });

                return res.json({ 
                    success: true, 
                    transferId: withdrawalRecord.transferId 
                });
            } else {
                throw new Error(response.data.error?.message || "xRocket Transfer Failed");
            }

        } catch (xRocketErr) {
            // 6. If Failed: Log to Withdrawal History
            const errorMessage = xRocketErr.response?.data?.error?.message || xRocketErr.message;
            
            console.error("xRocket API Error:", errorMessage);

            await Withdrawal.create({
                userId: String(userId),
                telegramId: Number(telegramId),
                amount: amount,
                status: 'failed',
                error: errorMessage
            });

            return res.status(500).json({ error: errorMessage });
        }

    } catch (err) {
        console.error("General Error:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- START SERVER ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Production Server listening on port ${PORT}`);
});
