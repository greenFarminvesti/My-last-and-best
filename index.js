const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

// ======================
// Middlewares
// ======================
app.use(cors()); // Fixes "Failed to fetch"
app.use(express.json());

// ======================
// 1. DATABASE CONNECTION
// ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Database Connected"))
  .catch(err => console.error("❌ Database Error:", err));

// ======================
// 2. MODELS
// ======================
const User = mongoose.model("User", new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 }
}, { timestamps: true }));

const Transaction = mongoose.model("Transaction", new mongoose.Schema({
  userId: String,
  transferId: String,
  amount: Number,
  status: { type: String, default: "pending" }, 
}, { timestamps: true }));

// ======================
// 3. XROCKET API HELPER
// ======================
async function sendPayout(tgUserId, amount) {
  const transferId = crypto.randomUUID();
  
  const response = await fetch("https://pay.xrocket.exchange/app/transfer", {
    method: "POST",
    headers: {
      "Rocket-Pay-Key": process.env.ROCKET_PAY_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tgUserId: Number(tgUserId),
      currency: "DOGS",
      amount: Number(amount),
      transferId: transferId,
      description: "Withdrawal from Mini App"
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `xRocket Error: ${response.status}`);
  }

  return transferId;
}

// ======================
// 4. ROUTES
// ======================

app.get("/", (req, res) => res.send("API is Live 🚀"));

// GET USER DATA
app.get("/api/user/:userId", async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WITHDRAW ROUTE
app.post("/api/withdraw", async (req, res) => {
  const { userId, tgUserId, amount } = req.body;

  try {
    const user = await User.findOne({ userId });
    
    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // 1. Call xRocket first
    const transferId = await sendPayout(tgUserId, amount);

    // 2. If payout call succeeded, deduct balance
    user.balance -= amount;
    user.totalWithdrawn += amount;
    await user.save();

    // 3. Log transaction
    await Transaction.create({
      userId,
      transferId,
      amount,
      status: "processing"
    });

    res.json({ success: true, message: "Withdrawal processing!" });

  } catch (error) {
    console.error("Withdraw Error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// WEBHOOK ROUTE
app.post("/api/webhook/xrocket", async (req, res) => {
  const { transfer_id, status } = req.body;
  
  const tx = await Transaction.findOne({ transferId: transfer_id });
  if (!tx) return res.sendStatus(404);

  if (status === "completed") {
    tx.status = "paid";
  } else if (status === "failed") {
    if (tx.status !== "failed") {
        tx.status = "failed";
        const user = await User.findOne({ userId: tx.userId });
        if (user) {
          user.balance += tx.amount;
          user.totalWithdrawn -= tx.amount;
          await user.save();
        }
    }
  }
  
  await tx.save();
  res.json({ received: true });
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
