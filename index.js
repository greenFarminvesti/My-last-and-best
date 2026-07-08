require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Setup Database Connections
const MONGODB_URI = process.env.MONGODB_URI;
const XROCKET_KEY = process.env.XROCKET_API_KEY;
const API_SECRET = process.env.API_SECRET;

// Firebase is ONLY here for the 1-minute migration
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

mongoose.connect(MONGODB_URI).then(() => console.log("✅ MongoDB Ready"));

// 2. The User Data Structure
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: String, unique: true },
    totalBalance: { type: Number, default: 0 },
    telegramId: Number
}, { strict: false }));

// --- THE TWO SIMPLEST STEPS ---

// STEP 1: VISIT THIS URL ONCE TO MOVE YOUR 213 USERS
// URL: https://your-app.railway.app/move-now?secret=YOUR_SECRET
app.get('/move-now', async (req, res) => {
    if (req.query.secret !== API_SECRET) return res.send("Wrong Secret");
    
    try {
        const snapshot = await admin.firestore().collection('users').get();
        const users = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            users.push({
                updateOne: {
                    filter: { userId: String(doc.id) },
                    update: { $set: { ...data, userId: String(doc.id) } },
                    upsert: true
                }
            });
        });
        await User.bulkWrite(users);
        res.send(`SUCCESS! Moved ${users.length} users. You can now use /withdraw.`);
    } catch (e) { res.send("Error: " + e.message); }
});

// STEP 2: THE WITHDRAWAL (No Firebase involved)
app.post('/withdraw', async (req, res) => {
    const { userId, telegramId, amount } = req.body;
    if (req.header('X-API-Key') !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });

    try {
        // 1. Find user in MongoDB
        const user = await User.findOne({ userId: String(userId) });
        if (!user) return res.status(404).json({ error: "User not found. Click /move-now first." });

        // 2. Check Balance
        if (user.totalBalance < amount) return res.status(400).json({ error: "Insufficient balance" });

        // 3. Send via xRocket
        const netAmount = Number((amount * 0.6).toFixed(2));
        const response = await axios.post('https://pay.xrocket.tg/app/transfer', {
            tgUserId: Number(telegramId),
            currency: 'DOGS',
            amount: netAmount,
            transferId: `id_${Date.now()}`,
            description: "Dogs Withdrawal"
        }, { headers: { 'Rocket-Pay-Key': XROCKET_KEY } });

        // 4. Update MongoDB balance
        if (response.data && response.data.success) {
            await User.findOneAndUpdate({ userId: String(userId) }, { $inc: { totalBalance: -amount } });
            return res.json({ success: true });
        } else {
            return res.status(400).json({ error: response.data.error?.message || "xRocket Failed" });
        }
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error?.message || err.message });
    }
});

app.get('/', (req, res) => res.send("Server is Online"));
app.listen(process.env.PORT || 3000, "0.0.0.0");
