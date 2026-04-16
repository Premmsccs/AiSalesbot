const express = require("express");
const router = express.Router();
const axios = require("axios");
const { pool } = require("../db"); // ✅ CHANGED (sql → pool)

// Simple in-memory session store (replace with Redis for production)
let conversationContext = {};

router.post("/", async (req, res) => {
  const userQuestion = req.body.message;
  const sessionId = req.body.sessionId || "default";

  if (!conversationContext[sessionId]) {
    conversationContext[sessionId] = { lastIntent: null, lastQuery: null, lastData: null };
  }

  try {
    console.log("User:", userQuestion);

    /* ================================
       🧠 STEP 0: INTENT DETECTION
    ================================= */
    const intentCheck = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        max_tokens: 5,
        messages: [
          {
            role: "system",
            content: `
Classify user message into ONE word:
- "chat" → casual talk
- "data" → database/business question
ONLY return one word.
`
          },
          { role: "user", content: userQuestion }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let intent = intentCheck.data.choices[0].message.content
      .trim()
      .toLowerCase();

    console.log("Intent:", intent);

    conversationContext[sessionId].lastIntent = intent;

    if (!intent) {
      return res.json({
        answer: "🤖 Sorry, I didn’t understand. Try again."
      });
    }

    /* ================================
       💬 STEP 1: CHAT MODE
    ================================= */
    if (intent === "chat" || intent.includes("chat")) {
      const chatResponse = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content: `
You are a smart business assistant like ChatGPT.

Talk naturally like a human, not like a report.
`
            },
            {
              role: "user",
              content: userQuestion
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const answer =
        chatResponse.data?.choices?.[0]?.message?.content ||
        "🙂 Hi! How can I help you?";

      return res.json({ answer });
    }

    /* ================================
       🧠 STEP 2: SQL GENERATION
    ================================= */
    const aiSQL = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `
You are a PostgreSQL expert.

Database tables:
products(productid, productname, price)
customers(customerid, customername, city, state, country)
stores(storeid, storename, city)
sales(salesid, productid, customerid, quantity, salestime, storeid)
inventory(productid, storeid, stock_quantity)
vendors(vendorid, vendorname, city)
logistics(shipmentid, salesid, shipment_status, dispatch_date, delivery_date)

Relationships:
- sales.productid = products.productid
- sales.customerid = customers.customerid
- sales.storeid = stores.storeid
- inventory.productid = products.productid
- inventory.storeid = stores.storeid
- logistics.salesid = sales.salesid

Rules:
- Use PostgreSQL syntax
- Use LIMIT instead of TOP
- Only SELECT queries
- Always JOIN tables when needed
- Sales calculation = quantity * price
- No explanation
`
          },
          { role: "user", content: userQuestion }
        ],
        temperature: 0
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let sqlQuery = aiSQL.data.choices[0].message.content.trim();
    sqlQuery = sqlQuery.replace(/```sql/g, "").replace(/```/g, "");

    console.log("SQL:", sqlQuery);

    /* ================================
       🧾 STEP 3: EXECUTE SQL
    ================================= */
    let result;
    try {
      result = await pool.query(sqlQuery); // ✅ CHANGED
    } catch (dbError) {
      return res.json({
        error: "SQL Error",
        details: dbError.message,
        query: sqlQuery
      });
    }

    const data = result.rows; // ✅ CHANGED

    conversationContext[sessionId].lastQuery = sqlQuery;
    conversationContext[sessionId].lastData = data;

    if (!data.length) {
      return res.json({ answer: "⚠️ No data found" });
    }

    /* ================================
       📊 STEP 4: BUSINESS ANALYSIS
    ================================= */
    const totalRevenue = data.reduce(
      (sum, d) => sum + (d.totalrevenue || 0),
      0
    );

    const topItem = data[0];

    const aiAnalysis = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `
You are a business analyst.
Give insights, trends, risks, recommendations.
`
          },
          {
            role: "user",
            content: `
User Question: ${userQuestion}
Data: ${JSON.stringify(data)}
Total Revenue: ${totalRevenue}
Top Item: ${JSON.stringify(topItem)}
`
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const insight = aiAnalysis.data.choices[0].message.content || "No insight";

    return res.json({
      query: sqlQuery,
      data: data,
      answer: insight
    });

  } catch (err) {
    console.error("ERROR:", err.response?.data || err.message);

    res.json({
      error: "AI failed",
      details: err.message
    });
  }
});

module.exports = router;