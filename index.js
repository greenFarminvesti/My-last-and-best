const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

// Enable CORS
app.use(cors());

// Parse JSON
app.use(express.json());
// ======================
// MongoDB Connection
// ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ======================
// Schemas & Models
// ======================
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, default: "" },
  walletAddress: { type: String, default: "" },
  balance: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 }
}, { timestamps: true });

const User = mongoose.model("User", UserSchema);

const TransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  transferId: { type: String, default: "" },
  walletAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: "DOGS" },
  status: { 
    type: String, 
    enum: ["pending", "processing", "paid", "failed"], 
    default: "pending" 
  },
  paidAt: Date
}, { timestamps: true });

const Transaction = mongoose.model("Transaction", TransactionSchema);

// ======================
// xRocket Helper Function
// ======================
async function sendPayout(tgUserId, amount) {
  const transferId = crypto.randomUUID();

  const response = await fetch("https://pay.xrocket.exchange/app/transfer", {
    method: "POST",
    headers: {
      "Rocket-Pay-Key": process.env.ROCKET_PAY_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      tgUserId: Number(tgUserId), // Ensure it's a number
      currency: "DOGS",
      amount: amount,
      transferId: transferId,
      description: "Auto payout from Mini App"
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || "xRocket Transfer failed");
  }

  return { transferId, data };
}

// ======================
// Routes
// ======================

// 1. Home Route
app.get("/", (req, res) => {
  res.json({ success: true, status: "Running", service: "Mini Withdraw Backend" });
});

// 2. Withdraw Route (Updated: No walletAddress needed)
app.post("/api/withdraw", async (req, res) => {
  try {
    // We only get these 3 from your frontend
    const { userId, tgUserId, amount } = req.body;

    // 1. Check if all required data is present
    if (!userId || !tgUserId || !amount) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields: userId, tgUserId, or amount" 
      });
    }

    // 2. Find the user in your Database
    const user = await User.findOne({ userId });

    // 3. Check if user exists and has enough money
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // 4. Send the payout via xRocket
    // (Ensure your sendPayout function is defined in your index.js)
    const transferId = await sendPayout(tgUserId, amount);

    // 5. If xRocket call was successful, update the User's balance
    user.balance -= amount;
    user.totalWithdrawn += amount;
    await user.save();

    // 6. Create a record in your Transaction history
    await Transaction.create({
      userId,
      transferId,
      amount,
      status: "processing"
    });

    // 7. Send success response back to the Mini App
    res.json({
      success: true,
      message: "Withdrawal submitted successfully",
      transferId: transferId
    });

  } catch (error) {
    console.error("Withdraw Error:", error.message);
    res.status(500).json({
      success: false,
      message: error.message || "Withdrawal failed"
    });
  }
});

// 3. Webhook Route (Called by xRocket)
app.post("/api/webhook/xrocket", async (req, res) => {
  try {
    console.log("📥 xRocket Webhook Received:", req.body);

    const { transfer_id, status } = req.body; 

    const transaction = await Transaction.findOne({ transferId: transfer_id });
    if (!transaction) return res.status(404).send("Transaction not found");

    if (status === "completed") {
      transaction.status = "paid";
      transaction.paidAt = new Date();
    } 
    else if (status === "failed") {
      transaction.status = "failed";
      // Refund the user if the payout failed
      const user = await User.findOne({ userId: transaction.userId });
      if (user) {
        user.balance += transaction.amount;
        user.totalWithdrawn -= transaction.amount;
        await user.save();
      }
    }

    await transaction.save();
    res.json({ success: true });

  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ======================
// Start Server
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
