// ================================================================
// OPTIONS TRADING BOT v2 — FULLY AUTOMATED WITH TRADIER
// ================================================================
// Portfolio : OKLO, LLY, PLTR, SPOK, XLE, CMBT, NOW, NVDA, TSLA, MSFT, AMD, AAPL
// Mandate   : $1,000–$2,000/day · $500–$1,000/trade · 8%+ return · 3–4 trades
// Execution : Auto-execute via Tradier API (sandbox mode)
// Alerts    : Push notifications via Pushover (instant, no carrier approval)
// Schedule  : Morning scan 9AM | Monitor every 20min | Close 4:05PM ET
// ================================================================
//
// INSTALL:  npm install
// RUN:      node options-bot.mjs
//
// .env keys required:
//   ANTHROPIC_API_KEY=sk-ant-...
//   TWILIO_ACCOUNT_SID=ACxxxxxxx        (keep for future use)
//   PUSHOVER_USER_KEY=xxxxxxx            (your Pushover user key)
//   PUSHOVER_API_TOKEN=xxxxxxx           (your Pushover app token)
//   ALPHA_VANTAGE_API_KEY=xxxxxxx
//   ALPHA_VANTAGE_API_KEY_2=xxxxxxx        (optional second key)
//   TRADIER_ACCESS_TOKEN=xxxxxxx            (from tradier.com/profile/api)
//   TRADIER_ACCOUNT_ID=xxxxxxx             (your Tradier account number)
//   TRADIER_SANDBOX=true                   (set to false for live trading)
// ================================================================

import Anthropic  from "@anthropic-ai/sdk";
// Pushover — instant push notifications, no carrier approval needed
import cron       from "node-cron";
import fetch      from "node-fetch";
import dotenv     from "dotenv";
dotenv.config();

// ── MANDATE ──────────────────────────────────────────────────
const MANDATE = {
  dailyCapMin:   1000,
  dailyCapMax:   2000,
  maxPerTrade:   1000,
  minPerTrade:   500,
  minReturnPct:  8,
  tradesPerDay:  { min: 3, max: 4 },
  // Exit rules
  profitTargetPct:  50,   // close spread at 50% of max profit
  stopLossPct:      100,  // close if position loses 100% of debit (full loss)
  maxDTE:           21,   // never buy options with more than 21 DTE
  minDTE:           1,    // close positions with 1 DTE remaining
};

// ── TRADIER CONFIG ────────────────────────────────────────────
const TRADIER = {
  sandbox: process.env.TRADIER_SANDBOX !== "false",
  get baseUrl() {
    return this.sandbox
      ? "https://sandbox.tradier.com/v1"
      : "https://api.tradier.com/v1";
  },
  token:     process.env.TRADIER_ACCESS_TOKEN,
  accountId: process.env.TRADIER_ACCOUNT_ID,
};

// ── PORTFOLIO ────────────────────────────────────────────────
const PORTFOLIO = [
  { ticker:"OKLO", name:"Oklo Inc",                shares:150,  avgCost:68.38,  stopLoss:55.00,  target:91.36,   sector:"Nuclear",      ivProfile:"high",   optionable:true,  earningsDate:"2026-08-12" },
  { ticker:"LLY",  name:"Eli Lilly",               shares:4.02, avgCost:987.00, stopLoss:880.00, target:1203.90, sector:"Pharma",       ivProfile:"medium", optionable:true,  earningsDate:"2026-08-06" },
  { ticker:"PLTR", name:"Palantir",                shares:13,   avgCost:135.00, stopLoss:105.00, target:160.00,  sector:"AI/Gov",       ivProfile:"medium", optionable:true,  earningsDate:"2026-08-04" },
  { ticker:"SPOK", name:"Spok Holdings",           shares:23.64,avgCost:13.00,  stopLoss:10.00,  target:14.00,   sector:"Healthcare",   ivProfile:"low",    optionable:true,  earningsDate:"2026-07-29" },
  { ticker:"XLE",  name:"Energy SPDR ETF",         shares:16.37,avgCost:59.45,  stopLoss:52.00,  target:65.00,   sector:"Energy",       ivProfile:"medium", optionable:true,  earningsDate:null },
  { ticker:"CMBT", name:"CMB.Tech NV",             shares:119.81,avgCost:119.00,stopLoss:95.00,  target:145.00,  sector:"Shipping",     ivProfile:"low",    optionable:false, earningsDate:null },
  { ticker:"NOW",  name:"ServiceNow",              shares:0,    avgCost:89.05,  stopLoss:70.00,  target:184.13,  sector:"SaaS",         ivProfile:"medium", optionable:true,  earningsDate:"2026-07-29" },
  { ticker:"NVDA", name:"Nvidia",                  shares:0,    avgCost:198.00, stopLoss:160.00, target:236.54,  sector:"AI/Semis",     ivProfile:"high",   optionable:true,  earningsDate:"2026-08-20" },
  { ticker:"TSLA", name:"Tesla",                   shares:0,    avgCost:375.53, stopLoss:310.00, target:440.00,  sector:"EV/Tech",      ivProfile:"high",   optionable:true,  earningsDate:"2026-07-22" },
  { ticker:"MSFT", name:"Microsoft",               shares:0,    avgCost:365.44, stopLoss:320.00, target:430.00,  sector:"Cloud/AI",     ivProfile:"high",   optionable:true,  earningsDate:"2026-07-28" },
  { ticker:"AMD",  name:"Advanced Micro Devices",  shares:0,    avgCost:120.00, stopLoss:96.00,  target:160.00,  sector:"Semis",        ivProfile:"high",   optionable:true,  earningsDate:"2026-07-28" },
  { ticker:"AAPL", name:"Apple Inc",               shares:0,    avgCost:298.01, stopLoss:262.00, target:317.40,  sector:"Consumer",     ivProfile:"medium", optionable:true,  earningsDate:"2026-07-31" },
];

const EARNINGS = {
  OKLO:"2026-08-12", LLY:"2026-08-06", PLTR:"2026-08-04",
  SPOK:"2026-07-29", NOW:"2026-07-29",  TSLA:"2026-07-22",
  MSFT:"2026-07-28", AMD:"2026-07-28",  AAPL:"2026-07-31",
  NVDA:"2026-08-20",
};

// ── STATE ─────────────────────────────────────────────────────
const state = {
  openPositions:    [],   // active options trades
  dailyTrades:      [],   // trades placed today
  alertsSent:       new Set(),
  priceCache:       {},
  dailyPnL:         0,
  totalDeployedToday: 0,
};

// ── CLIENTS ──────────────────────────────────────────────────
const ai  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PUSHOVER = {
  user:  process.env.PUSHOVER_USER_KEY  || "u3h5z2iissjoagim6uu142zersmqre",
  token: process.env.PUSHOVER_API_TOKEN || "au8xzb8irkcdw1udkt7qk2htdxz5yw",
};

// ═══════════════════════════════════════════════════════════════
// TRADIER API — OPTIONS EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════

async function tradierRequest(method, path, params = {}) {
  const url = `${TRADIER.baseUrl}${path}`;
  const headers = {
    "Authorization": `Bearer ${TRADIER.token}`,
    "Accept":        "application/json",
  };

  let res;
  if (method === "GET") {
    const qs = new URLSearchParams(params).toString();
    res = await fetch(`${url}${qs ? "?" + qs : ""}`, { headers });
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    res = await fetch(url, {
      method,
      headers,
      body: new URLSearchParams(params).toString(),
    });
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tradier ${method} ${path} failed (${res.status}): ${err}`);
  }
  return res.json();
}

// ── Get option chain for a ticker ────────────────────────────
async function getOptionChain(ticker, expiration) {
  try {
    const data = await tradierRequest("GET", "/markets/options/chains", {
      symbol:     ticker,
      expiration: expiration,
      greeks:     "true",
    });
    return data?.options?.option || [];
  } catch (e) {
    console.error(`  ✗ Option chain fetch failed for ${ticker}: ${e.message}`);
    return [];
  }
}

// ── Get available expirations ─────────────────────────────────
async function getExpirations(ticker) {
  try {
    const data = await tradierRequest("GET", "/markets/options/expirations", {
      symbol:           ticker,
      includeAllRoots:  "true",
    });
    return data?.expirations?.date || [];
  } catch (e) {
    console.error(`  ✗ Expirations fetch failed for ${ticker}: ${e.message}`);
    return [];
  }
}

// ── Get account balances ──────────────────────────────────────
async function getAccountBalances() {
  try {
    const data = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/balances`);
    return data?.balances || {};
  } catch (e) {
    console.error(`  ✗ Balance fetch failed: ${e.message}`);
    return {};
  }
}

// ── Get open positions ────────────────────────────────────────
async function getTradierPositions() {
  try {
    const data = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/positions`);
    const positions = data?.positions?.position;
    if (!positions) return [];
    return Array.isArray(positions) ? positions : [positions];
  } catch (e) {
    console.error(`  ✗ Positions fetch failed: ${e.message}`);
    return [];
  }
}

// ── Get option quote (current price of contract) ──────────────
async function getOptionQuote(symbols) {
  try {
    const data = await tradierRequest("GET", "/markets/quotes", {
      symbols:  Array.isArray(symbols) ? symbols.join(",") : symbols,
      greeks:   "true",
    });
    const quotes = data?.quotes?.quote;
    if (!quotes) return [];
    return Array.isArray(quotes) ? quotes : [quotes];
  } catch (e) {
    console.error(`  ✗ Option quote failed: ${e.message}`);
    return [];
  }
}

// ── Place multi-leg options order ────────────────────────────
async function placeOptionsOrder(trade) {
  const { ticker, strategy, legs, quantity } = trade;

  console.log(`  📤 Placing ${strategy} on ${ticker}...`);

  if (TRADIER.sandbox) {
    console.log(`  🔧 SANDBOX MODE — order simulated`);
  }

  try {
    let orderParams = {
      class:    "multileg",
      symbol:   ticker,
      type:     "market",
      duration: "day",
    };

    // Add each leg
    legs.forEach((leg, i) => {
      orderParams[`option_symbol[${i}]`] = leg.symbol;
      orderParams[`side[${i}]`]          = leg.side;       // buy_to_open, sell_to_open
      orderParams[`quantity[${i}]`]      = quantity || 1;
    });

    const data = await tradierRequest(
      "POST",
      `/accounts/${TRADIER.accountId}/orders`,
      orderParams
    );

    const orderId = data?.order?.id;
    console.log(`  ✅ Order placed: ID ${orderId}`);
    return { success: true, orderId, data };

  } catch (e) {
    console.error(`  ✗ Order failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ── Close an options position ─────────────────────────────────
async function closeOptionsPosition(position) {
  console.log(`  📤 Closing position: ${position.symbol}...`);
  try {
    // Determine close side based on open side
    const closeSide = position.side === "buy_to_open" ? "sell_to_close" : "buy_to_close";

    const data = await tradierRequest(
      "POST",
      `/accounts/${TRADIER.accountId}/orders`,
      {
        class:         "option",
        symbol:        position.underlyingSymbol || position.ticker,
        option_symbol: position.symbol,
        side:          closeSide,
        quantity:      Math.abs(position.quantity),
        type:          "market",
        duration:      "day",
      }
    );

    const orderId = data?.order?.id;
    console.log(`  ✅ Close order placed: ID ${orderId}`);
    return { success: true, orderId };
  } catch (e) {
    console.error(`  ✗ Close order failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ── Find best option spread for a trade recommendation ────────
async function buildOptionsLegs(tradeRec, stockPrice) {
  const { ticker, strategy } = tradeRec;

  try {
    // Get nearest expiration within DTE range
    const expirations = await getExpirations(ticker);
    const today = new Date();

    const validExp = expirations.find(exp => {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
      return dte >= 5 && dte <= MANDATE.maxDTE;
    });

    if (!validExp) {
      console.log(`  ⚠ No valid expiration found for ${ticker}`);
      return null;
    }

    const chain = await getOptionChain(ticker, validExp);
    if (!chain.length) return null;

    const calls = chain.filter(o => o.option_type === "call").sort((a,b) => a.strike - b.strike);
    const puts  = chain.filter(o => o.option_type === "put").sort((a,b) => b.strike - a.strike);

    // Build legs based on strategy
    switch (strategy) {
      case "Bull Call Spread": {
        // Buy ATM call, sell OTM call
        const longCall  = calls.find(c => c.strike >= stockPrice * 0.99);
        const shortCall = calls.find(c => c.strike >= stockPrice * 1.04);
        if (!longCall || !shortCall) return null;
        const cost = (longCall.ask - shortCall.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        return {
          expiration: validExp,
          legs: [
            { symbol: longCall.symbol,  side: "buy_to_open",  strike: longCall.strike,  type:"call" },
            { symbol: shortCall.symbol, side: "sell_to_open", strike: shortCall.strike, type:"call" },
          ],
          debit:       (longCall.ask - shortCall.bid).toFixed(2),
          cost:        Math.round(cost),
          maxProfit:   Math.round((shortCall.strike - longCall.strike - (longCall.ask - shortCall.bid)) * 100),
          breakeven:   (longCall.strike + longCall.ask - shortCall.bid).toFixed(2),
          longSymbol:  longCall.symbol,
          shortSymbol: shortCall.symbol,
          longStrike:  longCall.strike,
          shortStrike: shortCall.strike,
        };
      }

      case "Bear Put Spread": {
        const longPut  = puts.find(p => p.strike <= stockPrice * 1.01);
        const shortPut = puts.find(p => p.strike <= stockPrice * 0.96);
        if (!longPut || !shortPut) return null;
        const cost = (longPut.ask - shortPut.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        return {
          expiration: validExp,
          legs: [
            { symbol: longPut.symbol,  side: "buy_to_open",  strike: longPut.strike,  type:"put" },
            { symbol: shortPut.symbol, side: "sell_to_open", strike: shortPut.strike, type:"put" },
          ],
          debit:       (longPut.ask - shortPut.bid).toFixed(2),
          cost:        Math.round(cost),
          maxProfit:   Math.round((longPut.strike - shortPut.strike - (longPut.ask - shortPut.bid)) * 100),
          breakeven:   (longPut.strike - longPut.ask + shortPut.bid).toFixed(2),
          longSymbol:  longPut.symbol,
          shortSymbol: shortPut.symbol,
          longStrike:  longPut.strike,
          shortStrike: shortPut.strike,
        };
      }

      case "Iron Condor": {
        // Sell OTM call spread + sell OTM put spread
        const shortCall = calls.find(c => c.strike >= stockPrice * 1.03);
        const longCall  = calls.find(c => c.strike >= stockPrice * 1.06);
        const shortPut  = puts.find(p => p.strike <= stockPrice * 0.97);
        const longPut   = puts.find(p => p.strike <= stockPrice * 0.94);
        if (!shortCall || !longCall || !shortPut || !longPut) return null;
        const credit = ((shortCall.bid - longCall.ask) + (shortPut.bid - longPut.ask)) * 100;
        if (credit < MANDATE.minPerTrade * 0.08) return null; // min 8% credit
        return {
          expiration: validExp,
          legs: [
            { symbol: shortCall.symbol, side: "sell_to_open", strike: shortCall.strike, type:"call" },
            { symbol: longCall.symbol,  side: "buy_to_open",  strike: longCall.strike,  type:"call" },
            { symbol: shortPut.symbol,  side: "sell_to_open", strike: shortPut.strike,  type:"put"  },
            { symbol: longPut.symbol,   side: "buy_to_open",  strike: longPut.strike,   type:"put"  },
          ],
          credit:      credit.toFixed(0),
          cost:        Math.round(credit),
          maxProfit:   Math.round(credit),
          isCredit:    true,
        };
      }

      case "Cash Secured Put": {
        const shortPut = puts.find(p => p.strike <= stockPrice * 0.95);
        if (!shortPut) return null;
        const credit = shortPut.bid * 100;
        if (credit < MANDATE.minPerTrade * 0.08) return null;
        return {
          expiration: validExp,
          legs: [
            { symbol: shortPut.symbol, side: "sell_to_open", strike: shortPut.strike, type:"put" },
          ],
          credit:    credit.toFixed(0),
          cost:      Math.round(shortPut.strike * 100), // cash secured
          maxProfit: Math.round(credit),
          isCredit:  true,
          shortSymbol: shortPut.symbol,
          shortStrike: shortPut.strike,
        };
      }

      case "Covered Call": {
        const shortCall = calls.find(c => c.strike >= stockPrice * 1.03);
        if (!shortCall) return null;
        const credit = shortCall.bid * 100;
        return {
          expiration: validExp,
          legs: [
            { symbol: shortCall.symbol, side: "sell_to_open", strike: shortCall.strike, type:"call" },
          ],
          credit:      credit.toFixed(0),
          cost:        0, // covered by existing shares
          maxProfit:   Math.round(credit),
          isCredit:    true,
          shortSymbol: shortCall.symbol,
          shortStrike: shortCall.strike,
        };
      }

      default:
        return null;
    }
  } catch (e) {
    console.error(`  ✗ buildOptionsLegs failed for ${ticker}: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// PRICE FEEDS
// ═══════════════════════════════════════════════════════════════

const AV_KEYS = [
  process.env.ALPHA_VANTAGE_API_KEY,
  process.env.ALPHA_VANTAGE_API_KEY_2,
].filter(Boolean);

const CACHE_TTL = 18 * 60 * 1000;

async function fetchStockPrice(ticker, keyIndex = 0) {
  const cached = state.priceCache[ticker];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) return cached.data;

  const apiKey = AV_KEYS[keyIndex % AV_KEYS.length] || AV_KEYS[0];
  try {
    const url  = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data?.Note || data?.Information) {
      if (AV_KEYS.length > 1 && keyIndex === 0) {
        await new Promise(r => setTimeout(r, 500));
        return fetchStockPrice(ticker, 1);
      }
      return cached?.data || null;
    }

    const q = data["Global Quote"];
    if (!q?.["05. price"]) throw new Error("No data");

    const result = {
      ticker,
      price:     parseFloat(q["05. price"]),
      change:    parseFloat(q["09. change"]),
      changePct: parseFloat(q["10. change percent"]),
      volume:    parseInt(q["06. volume"]),
      high:      parseFloat(q["03. high"]),
      low:       parseFloat(q["04. low"]),
    };

    state.priceCache[ticker] = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error(`  ✗ ${ticker} price failed: ${e.message}`);
    return cached?.data || null;
  }
}

async function fetchAllPrices() {
  console.log(`  Fetching prices (${AV_KEYS.length} key(s))...`);
  const results = [];
  for (let i = 0; i < PORTFOLIO.length; i++) {
    const stock = PORTFOLIO[i];
    const data  = await fetchStockPrice(stock.ticker, i % AV_KEYS.length);
    if (data) results.push({ ...stock, ...data });
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`  ✓ Prices: ${results.length}/${PORTFOLIO.length}`);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// AI — TRADE GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateTrades(portfolioData) {
  const optionable = portfolioData.filter(p => p.optionable && p.price);
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });

  const earningsWarnings = Object.entries(EARNINGS)
    .map(([t,d]) => ({ t, d, days: Math.ceil((new Date(d)-new Date())/(1000*60*60*24)) }))
    .filter(e => e.days > 0 && e.days <= 14)
    .map(e => `${e.t} reports in ${e.days} days`);

  const prompt = `You are a professional options trader. Generate ${MANDATE.tradesPerDay.min}–${MANDATE.tradesPerDay.max} options trades for today.

DATE: ${today}
MANDATE:
- Cost per trade: $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}
- Total daily capital: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}
- Minimum return: ${MANDATE.minReturnPct}%
- Exit at: ${MANDATE.profitTargetPct}% of max profit
- Max DTE: ${MANDATE.maxDTE} days

LIVE PORTFOLIO PRICES:
${optionable.map(p => `${p.ticker}: $${p.price?.toFixed(2)} ${(p.changePct||0)>=0?"▲":"▼"}${Math.abs(p.changePct||0).toFixed(2)}% | IV: ${p.ivProfile}`).join("\n")}

${earningsWarnings.length ? `⚠️ EARNINGS: ${earningsWarnings.join(", ")} — avoid these or use straddles` : "No earnings this week"}

TODAY'S BUDGET REMAINING: $${MANDATE.dailyCapMax - state.totalDeployedToday}

Strategy guide:
- HIGH IV (OKLO, NVDA, TSLA, MSFT, AMD): Iron Condor, Cash Secured Put, Covered Call — sell premium
- MEDIUM IV (LLY, PLTR, XLE, NOW, AAPL): Bull Call Spread, Bear Put Spread — directional
- Avoid tickers with earnings within 7 days unless using straddle

Return ONLY a valid JSON array, no markdown:
[{
  "ticker": "NVDA",
  "strategy": "Bull Call Spread",
  "direction": "BULLISH",
  "targetCost": 900,
  "targetReturnPct": "10.0",
  "rationale": "NVDA up 2% with high IV — spread captures momentum",
  "setupScore": 8,
  "exitTarget": "Close when spread gains 50% of max profit"
}]`;

  const msg = await ai.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages:   [{ role:"user", content:prompt }],
  });

  const raw   = msg.content[0].text.trim().replace(/^```json\s*/i,"").replace(/```\s*$/i,"").trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON in AI response");

  return JSON.parse(match[0]).filter(t =>
    t.setupScore >= 6 &&
    t.targetCost >= MANDATE.minPerTrade &&
    t.targetCost <= MANDATE.maxPerTrade
  );
}

// ═══════════════════════════════════════════════════════════════
// MESSAGING
// ═══════════════════════════════════════════════════════════════

async function sendSMS(body) {
  // Using Pushover for instant push notifications
  try {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        token:   PUSHOVER.token,
        user:    PUSHOVER.user,
        message: body.slice(0, 1024),
        title:   "Options Bot",
        sound:   "cashregister",
      }).toString(),
    });
    const data = await res.json();
    if (data.status === 1) {
      console.log(`  ✅ Push notification sent`);
    } else {
      console.error(`  ✗ Pushover failed:`, data.errors);
    }
  } catch (e) {
    console.error(`  ✗ Push notification failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// POSITION MONITOR — check open trades and auto-close at target
// ═══════════════════════════════════════════════════════════════

async function monitorOpenPositions() {
  const positions = await getTradierPositions();
  if (!positions.length) return;

  console.log(`  Monitoring ${positions.length} open position(s)...`);

  for (const pos of positions) {
    try {
      // Get current option quote
      const quotes = await getOptionQuote(pos.symbol);
      if (!quotes.length) continue;

      const quote        = quotes[0];
      const currentValue = (quote.bid + quote.ask) / 2;
      const costBasis    = Math.abs(pos.cost_basis || 0);
      const qty          = Math.abs(pos.quantity);

      // Find matching trade in our state
      const ourTrade = state.openPositions.find(t =>
        t.legs?.some(l => l.symbol === pos.symbol)
      );

      if (!ourTrade) continue;

      const openDebit    = ourTrade.executedCost / qty / 100;
      const maxProfit    = ourTrade.maxProfit / qty / 100;
      const profitTarget = openDebit + (maxProfit * MANDATE.profitTargetPct / 100);
      const stopLevel    = openDebit * (1 - MANDATE.stopLossPct / 100);

      const currentPnL    = (currentValue - openDebit) * qty * 100;
      const currentPnLPct = ((currentValue - openDebit) / openDebit * 100).toFixed(1);

      // Check DTE
      const expDate = new Date(ourTrade.expiration);
      const dte     = Math.ceil((expDate - new Date()) / (1000*60*60*24));

      console.log(`  ${pos.symbol}: current $${currentValue.toFixed(2)} | P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPnLPct}%) | DTE: ${dte}`);

      let shouldClose = false;
      let closeReason = "";

      // Exit conditions
      if (currentValue >= profitTarget) {
        shouldClose = true;
        closeReason = `🎯 PROFIT TARGET HIT — ${currentPnLPct}% gain = +$${currentPnL.toFixed(0)}`;
      } else if (dte <= MANDATE.minDTE) {
        shouldClose = true;
        closeReason = `📅 EXPIRY RISK — ${dte} DTE remaining, closing to avoid assignment`;
      } else if (currentValue <= stopLevel && !ourTrade.isCredit) {
        shouldClose = true;
        closeReason = `🛑 STOP LOSS — position down ${Math.abs(currentPnLPct)}% = -$${Math.abs(currentPnL).toFixed(0)}`;
      }

      if (shouldClose) {
        console.log(`  ${closeReason}`);

        // Auto-close the position
        const result = await closeOptionsPosition({
          symbol:           pos.symbol,
          underlyingSymbol: ourTrade.ticker,
          quantity:         qty,
          side:             pos.quantity > 0 ? "buy_to_open" : "sell_to_open",
        });

        if (result.success) {
          state.dailyPnL += currentPnL;
          state.openPositions = state.openPositions.filter(t => t !== ourTrade);

          await sendSMS(
`◈ POSITION CLOSED
${ourTrade.ticker} ${ourTrade.strategy}
${closeReason}

P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPnLPct}%)
Order ID: ${result.orderId}
Today's P&L: ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}

Not financial advice.`
          );
        }
      }
    } catch (e) {
      console.error(`  ✗ Monitor failed for ${pos.symbol}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ═══════════════════════════════════════════════════════════════
// ALERT DETECTION — stock price alerts on underlying
// ═══════════════════════════════════════════════════════════════

function detectAlerts(stock, priceData) {
  const alerts = [];
  const price  = priceData.price;

  if (stock.stopLoss && price <= stock.stopLoss) {
    alerts.push({ type:"STOP_LOSS", urgency:"🚨 CRITICAL", msg:`$${price.toFixed(2)} hit stop-loss $${stock.stopLoss}. Exit or hedge immediately.` });
  } else if (stock.stopLoss && price <= stock.stopLoss * 1.05) {
    alerts.push({ type:"STOP_WARNING", urgency:"⚠️ WARNING", msg:`$${price.toFixed(2)} within 5% of stop-loss $${stock.stopLoss}.` });
  }
  if (stock.target && price >= stock.target) {
    alerts.push({ type:"TARGET_HIT", urgency:"🎯 TARGET", msg:`$${price.toFixed(2)} reached target $${stock.target}. Consider selling covered calls.` });
  }
  const absPct = Math.abs(priceData.changePct || 0);
  if (absPct >= 6) {
    alerts.push({ type:"BIG_MOVE", urgency:`${priceData.changePct>0?"🚀":"📉"} ${absPct.toFixed(1)}%`, msg:`Large move — options opportunity. IV likely elevated.` });
  }
  const earningsDate = EARNINGS[stock.ticker];
  if (earningsDate) {
    const days = Math.ceil((new Date(earningsDate) - new Date()) / (1000*60*60*24));
    if ([7, 3, 1].includes(days)) {
      alerts.push({ type:"EARNINGS", urgency:"📅 EARNINGS", msg:`Reports in ${days} day${days===1?"":"s"} (${earningsDate}). Close or roll options before then.` });
    }
  }
  return alerts;
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULED JOBS
// ═══════════════════════════════════════════════════════════════

// ── MORNING: Generate + auto-execute trades ───────────────────
async function morningSession() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🌅 Morning session starting...`);

  // Reset daily state
  state.dailyTrades      = [];
  state.totalDeployedToday = 0;
  state.dailyPnL         = 0;

  // Check account
  const balances = await getAccountBalances();
  const buyingPower = balances?.option_buying_power || balances?.cash || 0;
  console.log(`  Account buying power: $${buyingPower}`);

  if (buyingPower < MANDATE.dailyCapMin && !TRADIER.sandbox) {
    await sendSMS(`⚠️ OPTIONS BOT\nInsufficient buying power: $${buyingPower}\nMinimum needed: $${MANDATE.dailyCapMin}\nNo trades placed today.`);
    return;
  }

  // Fetch prices
  const portfolioData = await fetchAllPrices();

  // Generate trade recommendations
  let trades = [];
  try {
    trades = await generateTrades(portfolioData);
    console.log(`  ✓ AI generated ${trades.length} trade recommendations`);
  } catch (e) {
    console.error(`  ✗ Trade generation failed: ${e.message}`);
    await sendSMS(`⚠️ OPTIONS BOT\nMorning scan failed: ${e.message}\nNo trades placed.`);
    return;
  }

  // Execute each trade
  const executedTrades = [];
  for (const trade of trades) {
    if (state.totalDeployedToday >= MANDATE.dailyCapMax) {
      console.log(`  Daily capital limit reached — stopping`);
      break;
    }

    const stockData = portfolioData.find(p => p.ticker === trade.ticker);
    if (!stockData?.price) continue;

    console.log(`\n  Processing: ${trade.ticker} ${trade.strategy}...`);

    // Build real options legs from live chain
    const legs = await buildOptionsLegs(trade, stockData.price);
    if (!legs) {
      console.log(`  ⚠ Could not build legs for ${trade.ticker} ${trade.strategy} — skipping`);
      continue;
    }

    // Check cost is within mandate
    if (legs.cost < MANDATE.minPerTrade || legs.cost > MANDATE.maxPerTrade) {
      console.log(`  ⚠ Cost $${legs.cost} outside mandate — skipping`);
      continue;
    }

    // Place the order
    const result = await placeOptionsOrder({
      ticker:   trade.ticker,
      strategy: trade.strategy,
      legs:     legs.legs,
      quantity: 1,
    });

    if (result.success || TRADIER.sandbox) {
      const executedTrade = {
        ...trade,
        ...legs,
        orderId:       result.orderId || "SANDBOX",
        executedAt:    new Date().toISOString(),
        executedCost:  legs.cost,
        executedPrice: stockData.price,
        status:        "OPEN",
      };

      executedTrades.push(executedTrade);
      state.openPositions.push(executedTrade);
      state.dailyTrades.push(executedTrade);
      state.totalDeployedToday += legs.cost;

      console.log(`  ✅ ${trade.ticker} ${trade.strategy} — $${legs.cost} deployed`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  // Send morning SMS
  const modeFlag = TRADIER.sandbox ? " [SANDBOX]" : "";
  const smsText = executedTrades.length > 0
    ? `◈ OPTIONS BOT MORNING${modeFlag}
${new Date().toLocaleDateString()}

${executedTrades.length} TRADES EXECUTED:
${executedTrades.map((t,i) => `${i+1}. ${t.ticker} ${t.strategy}
   Cost: $${t.executedCost} | Target: ${t.targetReturnPct}% return
   Expiry: ${t.expiration}
   Order: ${t.orderId}`).join("\n\n")}

Total deployed: $${state.totalDeployedToday}
Buying power remaining: $${Math.max(0, buyingPower - state.totalDeployedToday).toFixed(0)}

Monitoring every 20 min. Auto-close at ${MANDATE.profitTargetPct}% of max profit.
Not financial advice.`
    : `◈ OPTIONS BOT MORNING${modeFlag}
${new Date().toLocaleDateString()}

No trades executed today.
Reasons: No setups met the 8% mandate or capital limit reached.
Monitoring continues.

Not financial advice.`;

  await sendSMS(smsText);
  console.log(`  ✅ Morning session complete. ${executedTrades.length} trades executed.`);
}

// ── INTRADAY: Monitor positions + stock alerts ────────────────
async function intradayCheck() {
  console.log(`\n[${new Date().toLocaleTimeString()}] ⚡ Intraday check...`);

  // Monitor open options positions
  await monitorOpenPositions();

  // Check stock price alerts
  const portfolioData = await fetchAllPrices();
  for (const stock of portfolioData) {
    if (!stock.price) continue;
    const alerts  = detectAlerts(stock, stock);
    const urgent  = alerts.filter(a => ["STOP_LOSS","STOP_WARNING","BIG_MOVE","EARNINGS","TARGET_HIT"].includes(a.type));
    if (!urgent.length) continue;

    const key = `${stock.ticker}_${urgent.map(a=>a.type).join("_")}_${new Date().getHours()}`;
    if (state.alertsSent.has(key)) continue;
    state.alertsSent.add(key);

    await sendSMS(
`⚡ ${stock.ticker} ALERT
Price: $${stock.price.toFixed(2)} ${(stock.changePct||0)>=0?"▲":"▼"}${Math.abs(stock.changePct||0).toFixed(2)}%

${urgent.map(a=>`${a.urgency}\n${a.msg}`).join("\n\n")}

Stop: $${stock.stopLoss||"N/A"} | Target: $${stock.target||"N/A"}
Not financial advice.`
    );
    console.log(`  ✅ Alert: ${stock.ticker} — ${urgent.map(a=>a.type).join(", ")}`);
  }

  const openCount = state.openPositions.length;
  console.log(`  ✓ Check complete. Open positions: ${openCount}`);
}

// ── CLOSING SUMMARY ───────────────────────────────────────────
async function closingSession() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🔔 Closing session...`);

  const portfolioData = await fetchAllPrices();
  const winners    = portfolioData.filter(p=>(p.changePct||0)>0).sort((a,b)=>b.changePct-a.changePct);
  const losers     = portfolioData.filter(p=>(p.changePct||0)<0).sort((a,b)=>a.changePct-b.changePct);
  const stillOpen  = state.openPositions.length;
  const modeFlag   = TRADIER.sandbox ? " [SANDBOX]" : "";

  await sendSMS(
`🔔 CLOSING SUMMARY${modeFlag}
${new Date().toLocaleDateString()}

OPTIONS TODAY:
Trades executed: ${state.dailyTrades.length}
Positions still open: ${stillOpen}
Realized P&L: ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}
Total deployed: $${state.totalDeployedToday}

STOCKS:
🟢 ${winners.slice(0,3).map(p=>`${p.ticker} +${(p.changePct||0).toFixed(1)}%`).join(", ")||"None"}
🔴 ${losers.slice(0,3).map(p=>`${p.ticker} ${(p.changePct||0).toFixed(1)}%`).join(", ")||"None"}

Not financial advice.`
  );

  // Reset daily alerts
  state.alertsSent.clear();
  console.log("  ✅ Closing summary sent.");
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════

const modeLabel = TRADIER.sandbox ? "SANDBOX" : "LIVE";

console.log(`\n🚀 Options Trading Bot v2 starting (${modeLabel} MODE)...`);
console.log(`📋 Portfolio: ${PORTFOLIO.map(p=>p.ticker).join(", ")}`);
console.log(`◎  Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day | $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | ${MANDATE.minReturnPct}%+ | Exit at ${MANDATE.profitTargetPct}% profit`);
console.log(`🔗 Tradier: ${TRADIER.baseUrl}`);
console.log("⏰ Schedule:");
console.log("   Mon–Fri 9:00 AM  — Morning scan + auto-execute trades");
console.log("   Mon–Fri 9:30–4PM — Monitor positions every 20 min");
console.log("   Mon–Fri 4:05 PM  — Closing summary\n");

// Morning execution: 9:00 AM ET Mon–Fri
cron.schedule("0 9 * * 1-5",       morningSession, { timezone:"America/New_York" });

// Intraday monitor: every 20 min 9:30–4 PM ET Mon–Fri
cron.schedule("*/20 9-16 * * 1-5", intradayCheck,  { timezone:"America/New_York" });

// Closing summary: 4:05 PM ET Mon–Fri
cron.schedule("5 16 * * 1-5",      closingSession, { timezone:"America/New_York" });

// Startup confirmation
await sendSMS(
`◈ OPTIONS BOT v2 ACTIVE (${modeLabel})
Portfolio: ${PORTFOLIO.filter(p=>p.optionable).map(p=>p.ticker).join(", ")}
Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day
Per trade: $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}
Min return: ${MANDATE.minReturnPct}%
Exit at: ${MANDATE.profitTargetPct}% of max profit
Auto-execute: ENABLED
Broker: Tradier ${modeLabel}

Schedule: 9AM execute | 20min monitor | 4PM close`
);

// Run initial check
await intradayCheck();
// Pushover v2 - Fri Jul 10 12:12:31 EDT 2026
