const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const { pool } = require("../db");

/* ============================================================
   PER-SESSION CHAT HISTORY
   Keyed by sessionId — multiple users never share state.
   Capped at 20 turns.
   ============================================================ */
const sessionHistories = new Map();

function getHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) sessionHistories.set(sessionId, []);
  return sessionHistories.get(sessionId);
}

function appendHistory(sessionId, role, content) {
  const h = getHistory(sessionId);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
}

/* ============================================================
   GROQ HELPER
   ============================================================ */
async function callGroq(messages, temperature = 0, model = "llama-3.3-70b-versatile") {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model, temperature, messages },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices[0].message.content.trim();
}

/* ============================================================
   SQL SAFETY GUARD
   Only allows SELECT queries.
   ============================================================ */
function isSafeQuery(query) {
  const q = query.toLowerCase().trim();
  if (!q.startsWith("select")) return false;
  const forbidden = ["drop","delete","update","insert","alter","truncate",
                     "exec","execute","create","merge","grant","revoke"];
  return !forbidden.some(w => new RegExp(`\\b${w}\\b`).test(q));
}

/* ============================================================
   SELF-HEAL SQL
   Strips markdown fences, fixes common issues.
   ============================================================ */
function selfHealSQL(query) {
  let q = query.replace(/```sql|```/gi, "").trim();
  // Remove trailing semicolons that can cause issues
  q = q.replace(/;\s*$/, "");
  return q;
}

/* ============================================================
   EMPTY RESULT MESSAGE
   ============================================================ */
function emptyMessage(question) {
  return `No records matched: **"${question}"**\n\nPossible reasons:\n- Filter value may not exist in the database\n- Date range has no data\n- Try broader filters or rephrase the question`;
}

/* ============================================================
   FILL INSIGHT TOKENS
   Replaces {{TOKEN}} placeholders with real DB values.
   Called AFTER DB runs — zero extra API calls.
   ============================================================ */
function fillInsightTokens(insightArray, data, chartYKey) {
  if (!data || data.length === 0) return insightArray;

  const keys     = Object.keys(data[0]);
  const labelKey = keys.find(k => isNaN(parseFloat(data[0][k]))) || keys[0];
  const valueKey = chartYKey && data[0][chartYKey] !== undefined
    ? chartYKey
    : keys.find(k => !isNaN(parseFloat(data[0][k]))) || keys[1];

  const values  = data.map(r => parseFloat(r[valueKey]) || 0);
  const total   = values.reduce((a, b) => a + b, 0);
  const top3sum = (values[0] || 0) + (values[1] || 0) + (values[2] || 0);
  const minVal  = Math.min(...values);
  const topPct  = total > 0 ? Math.round((values[0] / total) * 100) + "%" : "N/A";
  const top3Pct = total > 0 ? Math.round((top3sum  / total) * 100) + "%" : "N/A";

  const fmtNum = (n) => {
    if (isNaN(n)) return String(n);
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n % 1 === 0 ? n.toLocaleString() : n.toFixed(2);
  };

  const tokenMap = {
    "{{ROW_0_label}}": String(data[0]?.[labelKey] ?? "—"),
    "{{ROW_0_value}}": fmtNum(values[0]),
    "{{ROW_1_label}}": String(data[1]?.[labelKey] ?? "—"),
    "{{ROW_1_value}}": fmtNum(values[1]),
    "{{ROW_2_label}}": String(data[2]?.[labelKey] ?? "—"),
    "{{ROW_2_value}}": fmtNum(values[2]),
    "{{TOTAL_value}}": fmtNum(total),
    "{{TOP_PCT}}":     topPct,
    "{{TOP3_PCT}}":    top3Pct,
    "{{ROWS}}":        String(data.length),
    "{{MIN_value}}":   fmtNum(minVal),
    "{{MAX_value}}":   fmtNum(values[0]),
  };

  return insightArray.map(bullet =>
    Object.entries(tokenMap).reduce(
      (str, [token, val]) => str.split(token).join(val),
      bullet
    )
  );
}

/* ============================================================
   EXECUTE WITH RETRY
   Attempt 0 — run the generated SQL.
   Attempt 1+ — fix and retry. Max 2 retries.
   ============================================================ */
async function executeWithRetry(question, initialQuery, maxRetries = 2) {
  let currentQuery = initialQuery;
  let lastError    = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isSafeQuery(currentQuery)) {
      throw new Error("Generated query contains unsafe operations and was blocked.");
    }
    try {
      const result = await pool.query(currentQuery);
      return { data: result.rows, finalQuery: currentQuery };
    } catch (err) {
      lastError = err;
      console.warn(`⚠️  SQL attempt ${attempt + 1} failed: ${err.message}`);

      if (attempt < maxRetries) {
        const fixed = await callGroq([
          {
            role: "system",
            content: `You are a PostgreSQL expert. Fix the failed query.
Error: ${err.message}
Return ONLY the corrected SQL. No explanation. No markdown fences. No semicolons at end.`
          },
          {
            role: "user",
            content: `Question: ${question}\n\nFailed SQL:\n${currentQuery}`
          }
        ]);
        currentQuery = selfHealSQL(fixed);
      }
    }
  }
  throw lastError;
}

/* ============================================================
   ✅ SINGLE API CALL — HANDLES EVERYTHING

   One prompt does ALL of this:
   1. Detects intent  (CHAT / CLARIFY / DATA / FOLLOWUP)
   2. Rewrites follow-up questions
   3. Generates PostgreSQL query
   4. Generates chart config
   5. Generates insight template with {{tokens}}
   6. Returns chat reply for CHAT/CLARIFY

   After the call:
   - DB runs SQL (no API)
   - fillInsightTokens() injects real values (no API)

   TOTAL: 1 API call. SQL retry: +1 per attempt (rare).
   ============================================================ */
async function singleCall(message, history) {
  const context = history.slice(-6)
    .map(h => `${h.role}: ${h.content}`).join("\n");

  const raw = await callGroq([
    {
      role: "system",
      content: `
You are an intelligent business data assistant that handles routing,
PostgreSQL query generation, chart selection, and insight writing — all in one.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: CLASSIFY INTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  CHAT     - greeting, thanks, small talk, how are you
  CLARIFY  - asking what the bot can do or how it works
  DATA     - wants numbers, reports, charts, analytics
  FOLLOWUP - refers to previous result ("same but", "now filter",
             "also show", "what about", "those", "add", "now show by")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: RETURN FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY a single valid JSON object. No markdown. No explanation.

FOR CHAT or CLARIFY intent:
{
  "intent": "CHAT",
  "reply": "your friendly conversational response here"
}

FOR DATA or FOLLOWUP intent:
{
  "intent": "DATA",
  "sql": "complete ready-to-run PostgreSQL query",
  "chart": {
    "type":  "bar" | "line" | "pie" | "none",
    "title": "descriptive chart title",
    "xKey":  "exact column name for x-axis",
    "yKey":  "exact column name for y-axis"
  },
  "insight": [
    "bullet 1 with {{tokens}}",
    "bullet 2 with {{tokens}}",
    "bullet 3 with {{tokens}}",
    "bullet 4 with {{tokens}}",
    "bullet 5 with {{tokens}}",
    "bullet 6 with {{tokens}}"
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSIGHT TOKEN SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write insight bullets using ONLY these tokens for data values.
Server replaces them with real DB values after query runs.

  {{ROW_0_label}}  = top entity name (product/customer/store)
  {{ROW_0_value}}  = top entity primary metric value
  {{ROW_1_label}}  = 2nd entity name
  {{ROW_1_value}}  = 2nd entity value
  {{ROW_2_label}}  = 3rd entity name
  {{ROW_2_value}}  = 3rd entity value
  {{TOTAL_value}}  = sum of all primary metric values
  {{TOP_PCT}}      = top entity % share of total
  {{TOP3_PCT}}     = top 3 combined % share
  {{ROWS}}         = total number of rows returned
  {{MIN_value}}    = smallest value in primary metric
  {{MAX_value}}    = largest value in primary metric

INSIGHT BULLET ORDER:
  1. Dominant: **{{ROW_0_label}}** leads with **{{ROW_0_value}}** (~**{{TOP_PCT}}** of total **{{TOTAL_value}}**)
  2. Concentration: Top 3 (**{{ROW_0_label}}**, **{{ROW_1_label}}**, **{{ROW_2_label}}**) = **{{TOP3_PCT}}** combined
  3. Distribution: Remaining {{ROWS}} records range from **{{MIN_value}}** to **{{ROW_2_value}}**
  4. Risk: Specific named risk based on the query topic
  5. Scope: Results cover {{ROWS}} records — full picture may differ
  6. Action: Specific recommendation naming **{{ROW_0_label}}** or **{{ROW_1_label}}**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATABASE SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  products(productid, productname, price)
  customers(customerid, customername, city, state, country)
  stores(storeid, storename, city)
  sales(salesid, productid, customerid, quantity, salestime, storeid)
  inventory(productid, storeid, stock_quantity)
  vendors(vendorid, vendorname, city)
  logistics(shipmentid, salesid, shipment_status, dispatch_date, delivery_date)

RELATIONSHIPS:
  sales.productid   = products.productid
  sales.customerid  = customers.customerid
  sales.storeid     = stores.storeid
  inventory.productid = products.productid
  inventory.storeid   = stores.storeid
  logistics.salesid   = sales.salesid

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUSINESS DEFINITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Revenue      = SUM(sales.quantity * products.price)
  Total Sales  = SUM(sales.quantity)
  Avg Price    = AVG(products.price)
  Stock Value  = SUM(inventory.stock_quantity * products.price)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POSTGRESQL RULES (never violate)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1.  Use LIMIT n — NOT TOP n (this is PostgreSQL not SQL Server)
  2.  Always JOIN tables when data spans multiple tables
  3.  Use COALESCE(col, 0) for nullable numeric columns
  4.  GROUP BY all non-aggregated SELECT columns
  5.  Use NULLIF(expr, 0) for denominators
  6.  HAVING uses full aggregate expression — not aliases
  7.  Use CAST(... AS FLOAT) before division
  8.  Date trends: ORDER BY date column ASC
  9.  Never hardcode dates unless user explicitly says one
  10. Use lowercase table and column names
  11. No semicolons at end of query
  12. Use TO_CHAR(date, 'YYYY-MM') for month grouping

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHART RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  line -> trends, monthly, time-series
  bar  -> category comparison (products, customers, stores, cities)
  pie  -> share/breakdown (max 8 slices)
  none -> single number, raw detail lists

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKED EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q: hello
A: {"intent":"CHAT","reply":"Hi! I'm your business data assistant. Ask me about sales, revenue, customers, products, inventory, or logistics and I'll pull the data instantly."}

Q: what can you do
A: {"intent":"CLARIFY","reply":"I can answer any question about your business data — sales revenue, top products, customer analysis, store performance, inventory levels, logistics status, and trends. I generate SQL queries, charts, and actionable insights automatically. Just ask naturally!"}

Q: top 10 products by revenue
A: {"intent":"DATA","sql":"SELECT p.productname, SUM(s.quantity * p.price) AS revenue FROM sales s JOIN products p ON s.productid = p.productid GROUP BY p.productname ORDER BY revenue DESC LIMIT 10","chart":{"type":"bar","title":"Top 10 Products by Revenue","xKey":"productname","yKey":"revenue"},"insight":["**{{ROW_0_label}}** is the top revenue-generating product at **{{ROW_0_value}}**, accounting for approximately **{{TOP_PCT}}** of total revenue of **{{TOTAL_value}}** across {{ROWS}} products.","The top 3 products (**{{ROW_0_label}}**, **{{ROW_1_label}}**, **{{ROW_2_label}}**) collectively contribute **{{TOP3_PCT}}** of total revenue, with **{{ROW_1_value}}** and **{{ROW_2_value}}** respectively.","The remaining products generate revenues ranging from **{{MIN_value}}** to **{{ROW_2_value}}**, showing a significant drop-off after the top tier.","Heavy revenue concentration in **{{ROW_0_label}}** creates supply and demand risk — any stock shortage could disproportionately impact total revenue.","Analysis covers the top {{ROWS}} products only — the full product catalogue may show additional revenue opportunities.","Recommend ensuring adequate inventory levels for **{{ROW_0_label}}** and **{{ROW_1_label}}** to protect revenue continuity."]}

Q: monthly sales trend this year
A: {"intent":"DATA","sql":"SELECT TO_CHAR(s.salestime, 'YYYY-MM') AS month, SUM(s.quantity * p.price) AS revenue FROM sales s JOIN products p ON s.productid = p.productid WHERE EXTRACT(YEAR FROM s.salestime) = EXTRACT(YEAR FROM CURRENT_DATE) GROUP BY month ORDER BY month ASC","chart":{"type":"line","title":"Monthly Revenue Trend — Current Year","xKey":"month","yKey":"revenue"},"insight":["Revenue peaked at **{{MAX_value}}** in the best month, against a low of **{{MIN_value}}** across {{ROWS}} months tracked this year.","Total revenue for the year stands at **{{TOTAL_value}}**, distributed across {{ROWS}} monthly periods.","The variance between the highest and lowest months indicates seasonal demand patterns worth investigating.","Consecutive months below average revenue signal a risk to annual targets and should trigger a sales push.","Data covers {{ROWS}} months in the current year — full-year comparison may require prior year data.","Recommend planning promotional campaigns during historically weaker months to even out revenue distribution."]}

Q: top customers by total spend
A: {"intent":"DATA","sql":"SELECT c.customername, SUM(s.quantity * p.price) AS totalspend FROM sales s JOIN customers c ON s.customerid = c.customerid JOIN products p ON s.productid = p.productid GROUP BY c.customername ORDER BY totalspend DESC LIMIT 10","chart":{"type":"bar","title":"Top 10 Customers by Total Spend","xKey":"customername","yKey":"totalspend"},"insight":["**{{ROW_0_label}}** is the highest-spending customer at **{{ROW_0_value}}**, representing **{{TOP_PCT}}** of total spend of **{{TOTAL_value}}** across {{ROWS}} customers.","The top 3 customers (**{{ROW_0_label}}**, **{{ROW_1_label}}**, **{{ROW_2_label}}**) account for **{{TOP3_PCT}}** of total customer spend.","Remaining customers spend between **{{MIN_value}}** and **{{ROW_2_value}}**, showing a long tail of lower-value accounts.","Over-reliance on **{{ROW_0_label}}** creates churn risk — losing this account would significantly impact revenue.","This analysis is limited to top {{ROWS}} customers — the full customer base may include high-potential accounts not shown here.","Recommend a dedicated account management program for **{{ROW_0_label}}** and **{{ROW_1_label}}** to protect and grow these relationships."]}

Q: revenue by store
A: {"intent":"DATA","sql":"SELECT st.storename, SUM(s.quantity * p.price) AS revenue FROM sales s JOIN stores st ON s.storeid = st.storeid JOIN products p ON s.productid = p.productid GROUP BY st.storename ORDER BY revenue DESC","chart":{"type":"pie","title":"Revenue Share by Store","xKey":"storename","yKey":"revenue"},"insight":["**{{ROW_0_label}}** is the top-performing store, generating **{{ROW_0_value}}** — approximately **{{TOP_PCT}}** of total revenue of **{{TOTAL_value}}**.","The top 2 stores (**{{ROW_0_label}}** and **{{ROW_1_label}}**) together account for **{{TOP3_PCT}}** of all store revenue across {{ROWS}} locations.","Remaining stores generate revenues from **{{MIN_value}}** to **{{ROW_2_value}}**, indicating uneven performance across the network.","Under-performing stores may need operational review — poor sales could indicate staffing, location, or product mix issues.","Store analysis covers {{ROWS}} locations — ensure all stores are correctly mapped in the system.","Recommend investigating what drives **{{ROW_0_label}}**'s success and applying those practices to lower-performing stores."]}

Q: low stock products
A: {"intent":"DATA","sql":"SELECT p.productname, i.stock_quantity, st.storename FROM inventory i JOIN products p ON i.productid = p.productid JOIN stores st ON i.storeid = st.storeid WHERE i.stock_quantity < 10 ORDER BY i.stock_quantity ASC LIMIT 20","chart":{"type":"bar","title":"Low Stock Products (< 10 units)","xKey":"productname","yKey":"stock_quantity"},"insight":["**{{ROW_0_label}}** has the critically lowest stock at **{{ROW_0_value}}** units, posing an immediate risk of stockout.","A total of **{{ROWS}}** products are below the 10-unit threshold, requiring urgent replenishment attention.","Stock levels across low-inventory products range from **{{MIN_value}}** to **{{MAX_value}}** units.","Any of these {{ROWS}} products running out completely will directly impact sales and customer satisfaction.","This list shows only products below 10 units — a broader low-stock review at 20-unit threshold may reveal more at-risk items.","Recommend immediate reorder for **{{ROW_0_label}}** and **{{ROW_1_label}}** and set automated reorder alerts at 15 units minimum."]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION CONTEXT (for FOLLOWUP resolution):
${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY the JSON object. No markdown. No explanation.
`,
    },
    { role: "user", content: message }
  ], 0.1);

  try {
    const clean = raw.replace(/```json|```/gi, "").trim();
    return JSON.parse(clean);
  } catch {
    const sqlMatch = raw.match(/SELECT[\s\S]+/i);
    return {
      intent:  "DATA",
      sql:     sqlMatch ? sqlMatch[0].trim() : "",
      chart:   { type: "none", title: "", xKey: "", yKey: "" },
      insight: ["Data retrieved. Review the table below for details."]
    };
  }
}

/* ============================================================
   MAIN ROUTE   POST /chat

   ┌──────────────────────────────────────────────────────────┐
   │  SINGLE API CALL — singleCall()                          │
   │                                                          │
   │  CHAT / CLARIFY  → return reply directly      [DONE]     │
   │                                                          │
   │  DATA / FOLLOWUP:                                        │
   │    executeWithRetry() — runs SQL on DB  (no API)         │
   │    fillInsightTokens() — injects values (no API)         │
   │                                              [DONE]      │
   └──────────────────────────────────────────────────────────┘

   TOTAL: 1 API call guaranteed.
   SQL retry: +1 per attempt (rare).
   ============================================================ */
router.post("/", async (req, res) => {
  const userQuestion = req.body.message?.trim();
  const sessionId    = req.body.sessionId || req.ip || "default";

  if (!userQuestion) {
    return res.status(400).json({ error: "Message is required." });
  }

  console.log(`\n👤 [${sessionId}] "${userQuestion}"`);

  const history = getHistory(sessionId);

  try {

    /* ── SINGLE API CALL ── */
    const result = await singleCall(userQuestion, history);
    const intent = result.intent || "DATA";

    console.log(`🧭 Intent: ${intent}`);

    /* ── CHAT / CLARIFY ── */
    if (intent === "CHAT" || intent === "CLARIFY") {
      const reply = result.reply || "How can I help you with your business data?";

      appendHistory(sessionId, "user",      userQuestion);
      appendHistory(sessionId, "assistant", reply);

      return res.json({
        response: reply,
        answer:   reply,        // ← kept for backward compatibility
        intent,
        query:    null,
        columns:  [],
        data:     [],
        chart:    null,
        insight:  reply,
        rowCount: 0
      });
    }

    /* ── DATA / FOLLOWUP ── */
    let sqlQuery = selfHealSQL(result.sql || "");

    console.log("🔥 FINAL SQL:\n", sqlQuery);
    console.log("📊 Chart:", result.chart);

    /* ── Run SQL on DB ── */
    const { data, finalQuery } = await executeWithRetry(userQuestion, sqlQuery);

    /* ── Fill tokens with real values ── */
    const insightArray  = Array.isArray(result.insight) ? result.insight : [result.insight || ""];
    const filledBullets = data.length > 0
      ? fillInsightTokens(insightArray, data, result.chart?.yKey)
      : insightArray;

    const insight = filledBullets.map(b => `• ${b}`).join("\n");

    appendHistory(sessionId, "user",      userQuestion);
    appendHistory(sessionId, "assistant", insight);

    const responseText = data.length === 0 ? emptyMessage(userQuestion) : insight;

    return res.json({
      response:  responseText,
      answer:    responseText,  // ← kept for backward compatibility
      query:     finalQuery,
      columns:   data.length > 0 ? Object.keys(data[0]) : [],
      data,
      chart:     data.length > 0 ? result.chart : null,
      insight:   responseText,
      intent,
      rowCount:  data.length
    });

  } catch (err) {
    console.error("❌", err.message);

    const friendly = err.message.includes("unsafe operations")
      ? "That request was blocked for security reasons."
      : "I couldn't answer that. Try rephrasing — for example: \"Show top 10 products by revenue\".";

    return res.status(500).json({
      error:    err.message,
      response: friendly,
      answer:   friendly,
      query:    null,
      columns:  [],
      data:     [],
      chart:    null,
      insight:  friendly
    });
  }
});

/* ============================================================
   CLEAR ROUTE   POST /chat/clear
   ============================================================ */
router.post("/clear", (req, res) => {
  const sessionId = req.body.sessionId || req.ip || "default";
  sessionHistories.delete(sessionId);
  console.log(`🗑️  History cleared for session ${sessionId}`);
  res.json({ message: "Conversation history cleared." });
});

module.exports = router;