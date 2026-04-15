const express = require("express");
const router = express.Router();
const axios = require("axios");
const { sql } = require("../db");

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
        max_tokens: 5, // 🔥 FIX: avoid long/dirty responses
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

    // 🔥 FIX: fallback if intent fails
    if (!intent) {
      return res.json({
        answer: "🤖 Sorry, I didn’t understand. Try again."
      });
    }

    /* ================================
       💬 STEP 1: CHAT MODE
    ================================= */
    // 🔥 FIX: improved condition
    if (intent === "chat" || intent.includes("chat")) {
      const chatResponse = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          max_tokens: 500, // 🔥 FIX
          messages: [
            {
              role: "system",
             content: `
You are a smart business assistant like ChatGPT.

Talk naturally like a human, not like a report.

Style:
- Friendly and conversational
- Simple English
- Explain like talking to a colleague
- No strict format
- No bullet forcing
- No robotic tone

But still:
- Use real data
- Give insights
- Give suggestions

Example tone:
"Based on your data, laptops are your top product. But I see 7 items are low in stock — you might face issues soon if demand continues."

IMPORTANT:
- Be natural
- Be clear
- Be helpful
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
       🧠 STEP 2: SQL GENERATION (Context-aware)
    ================================= */
    const aiSQL = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `
You are a SQL Server expert.

Database tables:
products(productID, productName, price)
customers(customerID, customerName, city, state, country)
stores(storeID, storeName, city)
sales(salesID, productID, customerID, quantity, salestime, storeID)
inventory(productID, storeID, stock_quantity)
vendors(vendorID, vendorName, city)
logistics(shipmentID, salesID, shipment_status, dispatch_date, delivery_date)

Relationships:
- sales.productID = products.productID
- sales.customerID = customers.customerID
- sales.storeID = stores.storeID
- inventory.productID = products.productID
- inventory.storeID = stores.storeID
- logistics.salesID = sales.salesID

Rules:
- Use SQL Server syntax (TOP, NOT LIMIT)
- Only SELECT queries
- Always JOIN tables when needed
- Sales calculation = quantity * price
- Do NOT use invalid columns
- No explanation

If user asks a follow-up, use previous context:
${JSON.stringify(conversationContext[sessionId])}
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

    // Convert LIMIT → TOP
    if (sqlQuery.toLowerCase().includes("limit")) {
      const match = sqlQuery.match(/limit\s+(\d+)/i);
      if (match) {
        sqlQuery = sqlQuery
          .replace(/select/i, `SELECT TOP ${match[1]}`)
          .replace(/limit\s+\d+/gi, "");
      }
    }

    console.log("SQL:", sqlQuery);

    /* ================================
       🧾 STEP 3: EXECUTE SQL
    ================================= */
    let result;
    try {
      result = await sql.query(sqlQuery);
    } catch (dbError) {
      return res.json({
        error: "SQL Error",
        details: dbError.message,
        query: sqlQuery
      });
    }

    const data = result.recordset;
    conversationContext[sessionId].lastQuery = sqlQuery;
    conversationContext[sessionId].lastData = data;

    if (!data.length) {
      return res.json({ answer: "⚠️ No data found" });
    }

    /* ================================
       📊 STEP 4: BUSINESS ANALYSIS
    ================================= */
    const totalRevenue = data.reduce(
      (sum, d) => sum + (d.TotalRevenue || d.totalamount || 0),
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

Provide:
- Top insight
- Trend
- Risk
- Recommendation

Max 4 bullet points.
Use context if available: ${JSON.stringify(conversationContext[sessionId])}
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
      answer: insight,
      context: conversationContext[sessionId]
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