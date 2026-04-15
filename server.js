require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");

const app = express();

/* ================================
   🔥 MIDDLEWARE
================================ */
app.use(cors());
app.use(express.json());

/* ================================
   🔥 DATABASE CONNECTION
================================ */
connectDB();

/* ================================
   🔥 ROUTES
================================ */
const chatRoute = require("./routes/chat");
app.use("/chat", chatRoute);

/* ================================
   🔥 HEALTH CHECK (NEW - SAFE)
================================ */
app.get("/", (req, res) => {
  res.send("✅ AI Backend Running...");
});

/* ================================
   🚀 START SERVER
================================ */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});