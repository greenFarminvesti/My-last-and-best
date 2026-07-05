const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ DB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// MODELS
const User = mongoose.model("User", new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 }
}));

const Transaction = mongoose.model("Transaction", new mongoose.Schema({
  userId: String,
  transferId: String,
  amount: Number,
  status: { type: String, default: "processing" }
}));

// XROCKET HELPER
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
      description: "Mini App Withdrawal"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "xRocket Error");
  return transferId;
}

// ROUTES
app.get("/", (req, res) => res.json({ status: "Running" }));

app.post("/api/withdraw", async (req, res) => {
  try {
    const { userId, tgUserId, amount } = req.body;
    if (!userId || !tgUserId || !amount) return res.status(400).json({ success: false, message: "Missing fields" });

    const user = await User.findOne({ userId });
    if (!user || user.balance < amount) return res.status(400).json({ success: false, message: "No balance" });

    const transferId = await sendPayout(tgUserId, amount);

    user.balance -= amount;
    await user.save();

    await Transaction.create({ userId, transferId, amount });

    res.json({ success: true, transferId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
