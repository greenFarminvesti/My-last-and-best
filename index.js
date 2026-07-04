const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(express.json());

// 1. DATABASE CONNECTION
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Database Connected"))
  .catch(err => console.error("❌ Database Error:", err));

// 2. USER MODEL (Keeps track of money)
const User = mongoose.model("User", new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 }
}, { timestamps: true }));

// 3. TRANSACTION MODEL (History of payments)
const Transaction = mongoose.model("Transaction", new mongoose.Schema({
  userId: String,
  transferId: String,
  amount: Number,
  status: { type: String, default: "pending" }, // pending, paid, failed
}, { timestamps: true }));

// 4. XROCKET API HELPER
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
      amount: amount,
      transferId: transferId,
      description: "Withdrawal from Mini App"
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "xRocket Error");
  return transferId;
}

// 5. WITHDRAW ROUTE (The feature users click)
app.post("/api/withdraw", async (req, res) => {
  const { userId, tgUserId, amount } = req.body;

  try {
    const user = await User.findOne({ userId });
    
    // Feature: Balance Validation
    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // Feature: Send Payout
    const transferId = await sendPayout(tgUserId, amount);

    // Feature: Update Database
    user.balance -= amount;
    user.totalWithdrawn += amount;
    await user.save();

    await Transaction.create({
      userId,
      transferId,
      amount,
      status: "processing"
    });

    res.json({ success: true, message: "Withdrawal processing!" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 6. WEBHOOK ROUTE (Feature to confirm if money actually arrived)
app.post("/api/webhook/xrocket", async (req, res) => {
  const { transfer_id, status } = req.body;
  
  const tx = await Transaction.findOne({ transferId: transfer_id });
  if (!tx) return res.sendStatus(404);

  if (status === "completed") {
    tx.status = "paid";
  } else if (status === "failed") {
    tx.status = "failed";
    // Feature: Auto-Refund logic
    const user = await User.findOne({ userId: tx.userId });
    if (user) {
      user.balance += tx.amount;
      user.totalWithdrawn -= tx.amount;
      await user.save();
    }
  }
  
  await tx.save();
  res.json({ received: true });
});

// 7. HEALTH CHECK
app.get("/", (req, res) => res.send("API is Live 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
