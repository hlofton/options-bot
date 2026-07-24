// ================================================================
// OPTIONS TRADING BOT v2 — FULLY AUTOMATED WITH TRADIER + PUSHOVER
// ================================================================
// Portfolio : 17 stocks — NVDA AMD AVGO MSFT AAPL AMZN GOOGL META
//             TSLA PANW CRWD SPY QQQ OKLO LLY PLTR NOW
// Removed   : SPOK (illiquid), CMBT (no options), XLE (replaced by SPY/QQQ)
// Added     : AMZN GOOGL META AVGO PANW CRWD SPY QQQ
// Mandate   : $1,000–$2,000/day · $500–$1,000/trade · 8%+ return
// Execution : Tradier API (sandbox or live)
// Alerts    : Pushover push notifications
// Schedule  : 9AM execute | 20min monitor | 4PM close | Sunday review
// ================================================================
//
// INSTALL:  npm install
// RUN:      node options-bot.mjs
//
// .env keys required:
//   ANTHROPIC_API_KEY=sk-ant-...
//   PUSHOVER_USER_KEY=u3h5z2iissjoagim6uu142zersmqre
//   PUSHOVER_API_TOKEN=au8xzb8irkcdw1udkt7qk2htdxz5yw
//   ALPHA_VANTAGE_API_KEY=xxxxxxx
//   ALPHA_VANTAGE_API_KEY_2=xxxxxxx     (optional — sign up twice for more quota)
//   ALPHA_VANTAGE_API_KEY_3=xxxxxxx     (optional — 17 stocks needs 3 keys ideally)
//   TRADIER_ACCESS_TOKEN=xxxxxxx
//   TRADIER_ACCOUNT_ID=VA14921089
//   TRADIER_SANDBOX=true                (set false for live trading)
// ================================================================

import Anthropic from "@anthropic-ai/sdk";
import cron      from "node-cron";
// fetch is native in Node 18+ — no import needed
import dotenv    from "dotenv";
dotenv.config();

// ── CRITICAL STARTUP GUARD ────────────────────────────────────
// Exit immediately if ANTHROPIC_API_KEY is missing — prevents
// silent failures and wasted retry loops
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("🛑 CRITICAL: ANTHROPIC_API_KEY is not set in environment variables.");
  console.error("   Add it to Railway Variables tab and redeploy.");
  process.exit(1);
}
// Show key preview for verification (never logs full key)
const _keyPreview = `${process.env.ANTHROPIC_API_KEY.slice(0,12)}...${process.env.ANTHROPIC_API_KEY.slice(-4)}`;
console.log(`🔑 Anthropic API key loaded: ${_keyPreview}`);
if (!process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
  console.error("⚠️  WARNING: ANTHROPIC_API_KEY does not start with sk-ant- — may be invalid or have extra spaces.");
}

// ── MANDATE ──────────────────────────────────────────────────
const MANDATE = {
  dailyCapMin:     1000,
  dailyCapMax:     2000,
  maxPerTrade:     1000,
  minPerTrade:     500,
  minReturnPct:    8,
  tradesPerDay:    { min: 3, max: 4 },
  profitTargetPct: 50,   // close at 50% of max profit
  stopLossPct:     100,  // DEBIT strategies (spreads): close if this % of the debit is lost
  creditStopLossPct: 200, // CREDIT strategies (Iron Condor, CSP): close if loss reaches this % of credit received
  maxDTE:          21,
  minDTE:          1,
};

// ── TRADIER ───────────────────────────────────────────────────
const TRADIER = {
  sandbox: process.env.TRADIER_SANDBOX !== "false",
  get baseUrl() { return this.sandbox ? "https://sandbox.tradier.com/v1" : "https://api.tradier.com/v1"; },
  token:     process.env.TRADIER_ACCESS_TOKEN,
  accountId: process.env.TRADIER_ACCOUNT_ID,
};

// ── PORTFOLIO — Updated July 12, 2026 ─────────────────────────
// 17 high-IV, liquid options stocks. All meet: daily volume >10K,
// ATM spread <$0.15, weekly expiries available, market cap >$200B
const PORTFOLIO = [
  // ── AI / SEMICONDUCTORS — highest IV, most profitable ─────
  { ticker:"NVDA", name:"Nvidia",                 shares:0,    avgCost:198.00, stopLoss:175.00, target:236.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true,  earningsDate:"2026-08-20" },
  { ticker:"AMD",  name:"Advanced Micro Devices", shares:0,    avgCost:546.72, stopLoss:480.00, target:650.00,  sector:"Semis",     ivProfile:"high",   optionable:true,  earningsDate:"2026-07-28" },
  { ticker:"AVGO", name:"Broadcom Inc",           shares:0,    avgCost:400.39, stopLoss:340.00, target:472.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true,  earningsDate:"2026-09-04" },

  // ── MEGA-CAP TECH — deepest liquidity, weekly expiries ────
  { ticker:"MSFT", name:"Microsoft",              shares:0,    avgCost:365.44, stopLoss:350.00, target:430.00,  sector:"Cloud/AI",  ivProfile:"high",   optionable:true,  earningsDate:"2026-07-28" },
  { ticker:"AAPL", name:"Apple Inc",              shares:0,    avgCost:298.01, stopLoss:277.00, target:350.00,  sector:"Consumer",  ivProfile:"medium", optionable:true,  earningsDate:"2026-07-31" },
  { ticker:"AMZN", name:"Amazon",                 shares:0,    avgCost:244.00, stopLoss:208.00, target:278.00,  sector:"Cloud/AI",  ivProfile:"high",   optionable:true,  earningsDate:"2026-07-31" },
  { ticker:"GOOGL",name:"Alphabet",               shares:0,    avgCost:357.18, stopLoss:314.00, target:410.00,  sector:"AI/Ads",    ivProfile:"high",   optionable:true,  earningsDate:"2026-07-28" },
  { ticker:"META", name:"Meta Platforms",         shares:0,    avgCost:620.00, stopLoss:588.00, target:780.00,  sector:"AI/Social", ivProfile:"high",   optionable:true,  earningsDate:"2026-07-29" },

  // ── HIGH VOLATILITY ───────────────────────────────────────
  { ticker:"TSLA", name:"Tesla",                  shares:0,    avgCost:375.53, stopLoss:320.00, target:440.00,  sector:"EV/Tech",   ivProfile:"high",   optionable:true,  earningsDate:"2026-07-22" },

  // ── CYBERSECURITY ─────────────────────────────────────────
  { ticker:"PANW", name:"Palo Alto Networks",     shares:0,    avgCost:325.91, stopLoss:286.00, target:370.00,  sector:"Cyber",     ivProfile:"high",   optionable:true,  earningsDate:"2026-08-18" },
  { ticker:"CRWD", name:"CrowdStrike",            shares:0,    avgCost:187.23, stopLoss:165.00, target:235.00,  sector:"Cyber",     ivProfile:"high",   optionable:true,  earningsDate:"2026-09-02" },  // 4-for-1 split completed Jul 2026

  // ── INDEX ETFs — 0DTE capable, deepest liquidity ─────────
  { ticker:"SPY",  name:"S&P 500 ETF",            shares:0,    avgCost:754.95, stopLoss:680.00, target:820.00,  sector:"Index",     ivProfile:"medium", optionable:true,  earningsDate:null },
  { ticker:"QQQ",  name:"Nasdaq 100 ETF",         shares:0,    avgCost:725.51, stopLoss:653.00, target:790.00,  sector:"Index",     ivProfile:"medium", optionable:true,  earningsDate:null },

  // ── EXISTING HOLDINGS ─────────────────────────────────────
  { ticker:"OKLO", name:"Oklo Inc",               shares:150,  avgCost:68.38,  stopLoss:42.00,  target:88.00,   sector:"Nuclear",   ivProfile:"high",   optionable:true,  earningsDate:"2026-08-12" },
  { ticker:"LLY",  name:"Eli Lilly",              shares:4.02, avgCost:987.00, stopLoss:1045.00,target:1350.00, sector:"Pharma",    ivProfile:"medium", optionable:true,  earningsDate:"2026-08-06" },
  { ticker:"PLTR", name:"Palantir",               shares:13,   avgCost:135.00, stopLoss:105.00, target:183.00,  sector:"AI/Gov",    ivProfile:"medium", optionable:true,  earningsDate:"2026-08-04" },
  // NOTE: NOW did 5-for-1 split in 2025. Price $107.71. Down 42% YTD. Earnings Jul 22.
  { ticker:"NOW",  name:"ServiceNow",             shares:0,    avgCost:107.71, stopLoss:88.00,  target:142.00,  sector:"SaaS",      ivProfile:"medium", optionable:true,  earningsDate:"2026-07-22" },
];

// ── EARNINGS CALENDAR ─────────────────────────────────────────
const EARNINGS = {
  NVDA:"2026-08-20", AMD:"2026-07-28",  AVGO:"2026-09-04",
  MSFT:"2026-07-28", AAPL:"2026-07-31", AMZN:"2026-07-31",
  GOOGL:"2026-07-28",META:"2026-07-29", TSLA:"2026-07-22",
  PANW:"2026-08-18", CRWD:"2026-08-26",
  OKLO:"2026-08-12", LLY:"2026-08-06",  PLTR:"2026-08-04",
  NOW:"2026-07-22",
};

// ── STRATEGIES BY IV PROFILE ──────────────────────────────────
// Covered Calls removed — no share positions on this platform
const STRATEGIES = {
  high:   ["Iron Condor","Cash Secured Put","Bear Put Spread","Bull Call Spread"],
  medium: ["Bull Call Spread","Bear Put Spread","Iron Condor"],
  low:    ["Long Call","Long Put","Bull Call Spread"],
};

// ── STATE ─────────────────────────────────────────────────────
const state = {
  openPositions:      [],
  dailyTrades:        [],
  alertsSent:         new Set(),
  priceCache:         {},
  dailyPnL:           0,
  totalDeployedToday: 0,
  dynamicLevels:      {},   // auto-updated stops + targets
  weeklyHighs:        {},   // highest price seen this week
  jobRunning:         null, // name of the currently executing scheduled job, or null
};

// ═══════════════════════════════════════════════════════════════
// SCHEDULER CONCURRENCY GUARD
// node-cron fires each schedule independently and does NOT wait for
// a previous invocation to finish before dispatching the next one.
// Two schedules ("intradayCheck" every 20 min, "opportunisticScan"
// at 11/1/3) land on the EXACT same minute three times a day, and
// any job could in principle run long enough to overlap with the
// next tick of itself. All scheduled jobs mutate shared state
// (openPositions, dailyTrades, totalDeployedToday, dailyPnL), so a
// single global lock serializes every scheduled run — nothing ever
// executes concurrently with anything else, regardless of timing.
// ═══════════════════════════════════════════════════════════════
// Jobs that fire only once per day with no built-in retry — if a lock
// collision skips one of these, it simply does not happen at all that
// day. Worth an explicit alert rather than a silent console line.
const CRITICAL_ONCE_DAILY_JOBS = new Set([
  "morningSession", "updateAnalystTargets", "closingSession", "sundaySummary",
]);

async function runExclusive(jobName, fn) {
  if (state.jobRunning) {
    const msg = `Skipping ${jobName} — "${state.jobRunning}" is still running`;
    console.log(`  ⏭  ${msg}`);
    if (CRITICAL_ONCE_DAILY_JOBS.has(jobName)) {
      await sendSMS(`⚠️ SCHEDULE COLLISION\n${msg}\n${jobName} will NOT run again today — no automatic retry for this job.`);
    }
    return;
  }
  state.jobRunning = jobName;
  try {
    await fn();
  } catch(e) {
    console.error(`  ✗ ${jobName} crashed: ${e.message}`);
  } finally {
    state.jobRunning = null;
  }
}

// ── CLIENTS ──────────────────────────────────────────────────
// Trim key to remove any accidental leading/trailing spaces
const ai = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || "").trim() });

const PUSHOVER = {
  user:  process.env.PUSHOVER_USER_KEY  || "u3h5z2iissjoagim6uu142zersmqre",
  token: process.env.PUSHOVER_API_TOKEN || "au8xzb8irkcdw1udkt7qk2htdxz5yw",
};

// ═══════════════════════════════════════════════════════════════
// DYNAMIC LEVEL HELPERS — auto trailing stops + analyst targets
// ═══════════════════════════════════════════════════════════════

function getStopLoss(ticker, staticStop) {
  return state.dynamicLevels[ticker]?.stopLoss ?? staticStop;
}

function getTarget(ticker, staticTarget) {
  return state.dynamicLevels[ticker]?.target ?? staticTarget;
}

function updateTrailingStop(ticker, currentPrice, staticStop, trailPct = 12) {
  if (!currentPrice) return { updated: false };
  const weekHigh = state.weeklyHighs[ticker] || currentPrice;
  if (currentPrice > weekHigh) state.weeklyHighs[ticker] = currentPrice;

  const currentStop    = getStopLoss(ticker, staticStop);
  const newTrailingStop = parseFloat((currentPrice * (1 - trailPct / 100)).toFixed(2));

  if (newTrailingStop > currentStop) {
    const oldStop = currentStop;
    state.dynamicLevels[ticker] = {
      ...(state.dynamicLevels[ticker] || {}),
      stopLoss:    newTrailingStop,
      lastUpdated: new Date().toISOString(),
    };
    console.log(`  📈 ${ticker} trailing stop: $${oldStop} → $${newTrailingStop} (price $${currentPrice})`);
    return { updated: true, oldStop, newStop: newTrailingStop };
  }
  return { updated: false };
}

// ═══════════════════════════════════════════════════════════════
// TRADIER API
// ═══════════════════════════════════════════════════════════════

async function tradierRequest(method, path, params = {}) {
  const url     = `${TRADIER.baseUrl}${path}`;
  const headers = { "Authorization": `Bearer ${TRADIER.token}`, "Accept": "application/json" };
  let res;
  if (method === "GET") {
    const qs = new URLSearchParams(params).toString();
    res = await fetch(`${url}${qs ? "?" + qs : ""}`, { headers });
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    res = await fetch(url, { method, headers, body: new URLSearchParams(params).toString() });
  }
  if (!res.ok) throw new Error(`Tradier ${method} ${path} (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getOptionChain(ticker, expiration) {
  try {
    const data = await tradierRequest("GET", "/markets/options/chains", { symbol:ticker, expiration, greeks:"true" });
    return data?.options?.option || [];
  } catch(e) { console.error(`  ✗ Chain ${ticker}: ${e.message}`); return []; }
}

async function getExpirations(ticker) {
  try {
    const data = await tradierRequest("GET", "/markets/options/expirations", { symbol:ticker, includeAllRoots:"true" });
    return data?.expirations?.date || [];
  } catch(e) { console.error(`  ✗ Expiry ${ticker}: ${e.message}`); return []; }
}

async function getAccountBalances() {
  try {
    const data = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/balances`);
    return data?.balances || {};
  } catch(e) { console.error(`  ✗ Balances: ${e.message}`); return {}; }
}

async function getTradierPositions() {
  try {
    const data = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/positions`);
    const p = data?.positions?.position;
    if (!p) return [];
    return Array.isArray(p) ? p : [p];
  } catch(e) { console.error(`  ✗ Positions: ${e.message}`); return []; }
}

async function getOptionQuote(symbols) {
  try {
    const data = await tradierRequest("GET", "/markets/quotes", {
      symbols: Array.isArray(symbols) ? symbols.join(",") : symbols, greeks:"true"
    });
    const q = data?.quotes?.quote;
    if (!q) return [];
    return Array.isArray(q) ? q : [q];
  } catch(e) { console.error(`  ✗ Quote: ${e.message}`); return []; }
}

async function placeOptionsOrder(trade) {
  const { ticker, strategy, legs, quantity } = trade;
  console.log(`  📤 Placing ${strategy} on ${ticker}...`);
  try {
    // Use limit orders in live trading to avoid bid-ask slippage on spreads.
    // In sandbox, market orders are fine — no real fills.
    const orderType = TRADIER.sandbox ? "market" : "limit";

    // Midpoint price — calculated from legs fetched in buildOptionsLegs
    // passed through as trade.limitPrice when available
    const limitPrice = (!TRADIER.sandbox && trade.limitPrice)
      ? trade.limitPrice.toFixed(2)
      : undefined;

    let params;
    if (legs.length === 1) {
      // Tradier REQUIRES class:"option" for single-leg orders — "multileg"
      // with 1 leg is rejected with a 400 error ("number of legs must be
      // greater than 1"). Single-leg orders also use different param names:
      // option_symbol / side / quantity (no [i] index suffix).
      params = {
        class:         "option",
        symbol:        ticker,
        option_symbol: legs[0].symbol,
        side:          legs[0].side,
        quantity:      quantity || 1,
        type:          orderType,
        duration:      "day",
        ...(limitPrice ? { price: limitPrice } : {}),
      };
    } else {
      params = {
        class:    "multileg",
        symbol:   ticker,
        type:     orderType,
        duration: "day",
        ...(limitPrice ? { price: limitPrice } : {}),
      };
      legs.forEach((leg, i) => {
        params[`option_symbol[${i}]`] = leg.symbol;
        // Tradier multileg API requires full side values: buy_to_open, sell_to_open,
        // buy_to_close, sell_to_close — confirmed via official Tradier docs.
        params[`side[${i}]`]          = leg.side;
        params[`quantity[${i}]`]      = quantity || 1;
      });
    }

    const data    = await tradierRequest("POST", `/accounts/${TRADIER.accountId}/orders`, params);
    const orderId = data?.order?.id;
    console.log(`  ✅ Order placed: ${orderId}`);
    return { success:true, orderId };
  } catch(e) {
    console.error(`  ✗ Order failed: ${e.message}`);
    return { success:false, error:e.message };
  }
}

async function closeOptionsPosition(position) {
  try {
    const closeSide = position.side === "buy_to_open" ? "sell_to_close" : "buy_to_close";
    const data = await tradierRequest("POST", `/accounts/${TRADIER.accountId}/orders`, {
      class:"option", symbol:position.underlyingSymbol || position.ticker,
      option_symbol:position.symbol, side:closeSide,
      quantity:Math.abs(position.quantity), type:"market", duration:"day",
    });
    return { success:true, orderId:data?.order?.id };
  } catch(e) { return { success:false, error:e.message }; }
}

async function buildOptionsLegs(tradeRec, stockPrice, regime = null) {
  const { ticker, strategy } = tradeRec;
  try {
    const expirations = await getExpirations(ticker);
    const today       = new Date();
    const validExp    = expirations.find(exp => {
      const dte = Math.ceil((new Date(exp) - today) / (1000*60*60*24));
      return dte >= 5 && dte <= MANDATE.maxDTE;
    });
    if (!validExp) return null;

    const chain = await getOptionChain(ticker, validExp);
    if (!chain.length) return null;

    const calls = chain.filter(o => o.option_type==="call").sort((a,b) => a.strike-b.strike);
    const puts  = chain.filter(o => o.option_type==="put").sort((a,b) => b.strike-a.strike);

    switch(strategy) {
      case "Bull Call Spread": {
        const bullOtm = (regime?.otmPct ?? 3) / 100;
        const lc = calls.find(c => c.strike >= stockPrice * 0.99);
        const sc = calls.find(c => c.strike >= stockPrice * (1 + bullOtm));
        if (!lc || !sc) return null;
        const cost = (lc.ask - sc.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        // Midpoint price for limit order — avoids slippage in live trading
        const midpoint = parseFloat(((lc.ask - sc.bid) / 2 + (lc.bid - sc.ask) / 2).toFixed(2));
        return { expiration:validExp, legs:[{symbol:lc.symbol,side:"buy_to_open"},{symbol:sc.symbol,side:"sell_to_open"}], cost:Math.round(cost), maxProfit:Math.round((sc.strike-lc.strike-(lc.ask-sc.bid))*100), longSymbol:lc.symbol, shortSymbol:sc.symbol, limitPrice:midpoint };
      }
      case "Bear Put Spread": {
        const bearOtm = (regime?.otmPct ?? 3) / 100;
        const lp = puts.find(p => p.strike <= stockPrice * 1.01);
        const sp = puts.find(p => p.strike <= stockPrice * (1 - bearOtm));
        if (!lp || !sp) return null;
        const cost = (lp.ask - sp.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        return { expiration:validExp, legs:[{symbol:lp.symbol,side:"buy_to_open"},{symbol:sp.symbol,side:"sell_to_open"}], cost:Math.round(cost), maxProfit:Math.round((lp.strike-sp.strike-(lp.ask-sp.bid))*100) };
      }
      case "Iron Condor": {
        // Dynamic OTM distance based on regime — wider wings in volatile markets
        const otmFactor   = (regime?.otmPct ?? 3) / 100;                          // e.g. 0.03, 0.04, 0.05
        const widthFactor = otmFactor + (0.03 * (regime?.wingMultiplier ?? 1.0)); // long wing further out
        console.log(`  📐 Iron Condor wings: ${(otmFactor*100).toFixed(0)}% OTM / ${(widthFactor*100).toFixed(1)}% width (regime: ${regime?.label || "DEFAULT"})`);
        const sc2 = calls.find(c => c.strike >= stockPrice * (1 + otmFactor));
        const lc2 = calls.find(c => c.strike >= stockPrice * (1 + widthFactor));
        const sp2 = puts.find(p  => p.strike  <= stockPrice * (1 - otmFactor));
        const lp2 = puts.find(p  => p.strike  <= stockPrice * (1 - widthFactor));
        if (!sc2||!lc2||!sp2||!lp2) {
          console.log(`  ✗ ${tradeRec.ticker} Iron Condor REJECTED — missing strike(s) in chain: shortCall=${!!sc2} longCall=${!!lc2} shortPut=${!!sp2} longPut=${!!lp2} (${calls.length} calls, ${puts.length} puts available)`);
          return null;
        }
        const creditPerContract = ((sc2.bid-lc2.ask)+(sp2.bid-lp2.ask))*100;
        if (creditPerContract <= 0) {
          console.log(`  ✗ ${tradeRec.ticker} Iron Condor REJECTED — non-positive credit: $${creditPerContract.toFixed(2)}/contract (call spread ${(sc2.bid-lc2.ask).toFixed(2)}, put spread ${(sp2.bid-lp2.ask).toFixed(2)})`);
          return null;
        }
        // Scale quantity so total credit lands inside the $500-$1000 mandate
        // range instead of comparing a 1-contract credit (often $100-400)
        // against a debit-spread-sized threshold.
        let qty = Math.max(1, Math.round(MANDATE.minPerTrade / creditPerContract));
        let totalCredit = creditPerContract * qty;
        while (totalCredit > MANDATE.maxPerTrade && qty > 1) { qty--; totalCredit = creditPerContract * qty; }
        if (totalCredit < MANDATE.minPerTrade * 0.5) {
          console.log(`  ✗ ${tradeRec.ticker} Iron Condor REJECTED — credit too low even at floor qty: $${creditPerContract.toFixed(2)}/contract × ${qty} = $${totalCredit.toFixed(0)} (need ≥ $${(MANDATE.minPerTrade*0.5).toFixed(0)})`);
          return null; // too little premium even at floor qty
        }
        const maxLossPerContract = Math.max((lc2.strike - sc2.strike), (sp2.strike - lp2.strike)) * 100 - creditPerContract;
        return {
          expiration: validExp,
          legs: [
            { symbol: sc2.symbol, side: "sell_to_open" },
            { symbol: lc2.symbol, side: "buy_to_open"  },
            { symbol: sp2.symbol, side: "sell_to_open" },
            { symbol: lp2.symbol, side: "buy_to_open"  },
          ],
          cost:            Math.round(totalCredit),
          maxProfit:       Math.round(totalCredit),
          maxLoss:         Math.round(maxLossPerContract * qty),
          quantity:        qty,
          isCredit:        true,
          // Short strikes — if the underlying trades beyond either of
          // these, the condor is structurally breached and should be
          // closed immediately regardless of dollar P&L thresholds.
          shortCallStrike: sc2.strike,
          shortPutStrike:  sp2.strike,
        };
      }
      case "Cash Secured Put": {
        const sp3 = puts.find(p => p.strike <= stockPrice*0.95);
        if (!sp3) return null;
        const creditPerContract = sp3.bid * 100;
        // Scale contract quantity so the CREDIT COLLECTED (not the
        // collateral) lands inside the mandate's $500-$1000 range.
        // "cost" now represents premium at risk, comparable to spreads.
        // "collateral" tracks the real cash-secured requirement separately
        // so account-balance checks stay accurate.
        let qty = Math.max(1, Math.round(MANDATE.minPerTrade / Math.max(creditPerContract, 1)));
        let totalCredit = creditPerContract * qty;
        // Cap quantity so we never exceed maxPerTrade in credit collected
        while (totalCredit > MANDATE.maxPerTrade && qty > 1) { qty--; totalCredit = creditPerContract * qty; }
        if (totalCredit < MANDATE.minPerTrade * 0.5) return null; // too little premium even at floor qty
        const collateral = sp3.strike * 100 * qty;
        return {
          expiration:  validExp,
          legs:        [{ symbol: sp3.symbol, side: "sell_to_open" }],
          cost:        Math.round(totalCredit),   // premium collected — compared against mandate
          collateral:  Math.round(collateral),    // actual cash-secured requirement — for balance checks only
          maxProfit:   Math.round(totalCredit),
          quantity:    qty,
          isCredit:    true,
        };
      }
      // Covered Call removed — no share positions on this platform
      default: return null;
    }
  } catch(e) { console.error(`  ✗ buildLegs ${ticker}: ${e.message}`); return null; }
}

// ═══════════════════════════════════════════════════════════════
// PRICE FEEDS — Alpha Vantage with multi-key rotation + cache
// ═══════════════════════════════════════════════════════════════

const AV_KEYS = [
  process.env.ALPHA_VANTAGE_API_KEY,
  process.env.ALPHA_VANTAGE_API_KEY_2,
  process.env.ALPHA_VANTAGE_API_KEY_3,
].filter(Boolean);

// Guard: fail loudly at startup if no Alpha Vantage keys are configured
// at all, rather than letting apiKey silently become "undefined" deep
// inside fetchStockPrice / fetchVIX / fetchSPYChange.
if (AV_KEYS.length === 0) {
  console.error("🛑 CRITICAL: No ALPHA_VANTAGE_API_KEY(_2/_3) configured. Price fetching will fail entirely.");
}

const CACHE_TTL = 18 * 60 * 1000;

async function fetchStockPrice(ticker, keyIndex = 0) {
  const cached = state.priceCache[ticker];
  if (cached && (Date.now()-cached.ts) < CACHE_TTL) return cached.data;

  const apiKey = AV_KEYS.length ? AV_KEYS[keyIndex % AV_KEYS.length] : undefined;
  try {
    const res  = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${apiKey}`);
    const data = await res.json();

    if (data?.Note || data?.Information) {
      if (AV_KEYS.length > 1 && keyIndex < AV_KEYS.length - 1) {
        await new Promise(r => setTimeout(r, 500));
        return fetchStockPrice(ticker, keyIndex + 1);
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
    state.priceCache[ticker] = { ts:Date.now(), data:result };
    return result;
  } catch(e) {
    console.error(`  ✗ ${ticker}: ${e.message}`);
    return cached?.data || null;
  }
}

async function fetchAllPrices() {
  console.log(`  Fetching ${PORTFOLIO.length} prices (${AV_KEYS.length} key(s))...`);
  const results = [];
  for (let i = 0; i < PORTFOLIO.length; i++) {
    const stock = PORTFOLIO[i];
    const data  = await fetchStockPrice(stock.ticker, i % AV_KEYS.length);
    if (data) results.push({ ...stock, ...data });
    // Scale delay linearly with portfolio size to stay under API limits.
    // Formula: base 1200ms + 50ms per stock beyond 17 (current baseline).
    // e.g. 20 stocks → 1350ms, 25 stocks → 1600ms, 30 stocks → 1850ms
    const scaledDelay = 1200 + Math.max(0, (PORTFOLIO.length - 17) * 50);
    await new Promise(r => setTimeout(r, scaledDelay));
  }
  console.log(`  ✓ Prices: ${results.length}/${PORTFOLIO.length}`);
  return results;
}

// ═══════════════════════════════════════════════════════════════
// PUSHOVER NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

async function sendSMS(body) {
  try {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method:  "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        token:   PUSHOVER.token,
        user:    PUSHOVER.user,
        message: body.slice(0, 1024),
        title:   "Options Bot",
        sound:   "cashregister",
      }).toString(),
    });
    const data = await res.json();
    if (data.status === 1) console.log(`  ✅ Push notification sent`);
    else console.error(`  ✗ Pushover failed:`, data.errors);
  } catch(e) { console.error(`  ✗ Push failed: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════
// MARKET SENTIMENT — VIX fetch + pre-market SPY change
// Used by generateTrades to adjust strategy selection and
// condor wing width based on current volatility environment
// ═══════════════════════════════════════════════════════════════

// VIX thresholds
const VIX_REGIME = {
  calm:     18,   // VIX < 18  → normal wings, all strategies allowed
  elevated: 25,   // VIX 18–25 → wider wings, avoid directional spreads
  fearful:  35,   // VIX 25–35 → widest wings, income only
                  // VIX > 35  → no new trades (extreme fear)
};

async function fetchVIX() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Use AV_KEYS rotation — don't hardcode primary key
      const key  = AV_KEYS[AV_KEYS.length - 1] || process.env.ALPHA_VANTAGE_API_KEY;
      const res  = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=^VIX&apikey=${key}`);
      const data = await res.json();
      const q    = data["Global Quote"];
      if (!q?.["05. price"]) throw new Error("No VIX data");
      const vix  = parseFloat(q["05. price"]);
      console.log(`  📊 VIX: ${vix}`);
      return vix;
    } catch(e) {
      if (attempt === 3) {
        console.log(`  ⚠ VIX fetch failed after 3 attempts — defaulting to 18`);
        return 18;
      }
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return 18;
}

async function fetchSPYChange() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Use AV_KEYS rotation — reserve last key for sentiment fetches
      const key     = AV_KEYS[AV_KEYS.length - 1] || process.env.ALPHA_VANTAGE_API_KEY;
      const res     = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${key}`);
      const data    = await res.json();
      const q       = data["Global Quote"];
      if (!q?.["10. change percent"]) throw new Error("No SPY data");
      const change  = parseFloat(q["10. change percent"]);
      console.log(`  📊 SPY day change: ${change.toFixed(2)}%`);
      return change;
    } catch(e) {
      if (attempt === 3) {
        console.log(`  ⚠ SPY change fetch failed after 3 attempts — defaulting to 0`);
        return 0;
      }
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return 0;
}

function getMarketRegime(vix, spyChangePct) {
  // Determine regime and rules for today's trading
  if (vix > VIX_REGIME.fearful) {
    return {
      label:            "EXTREME FEAR",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         false,
      skipTrading:      true,
      wingMultiplier:   2.0,
      note:             `VIX ${vix} > 35 — no new trades today. Extreme fear.`,
    };
  }
  if (vix > VIX_REGIME.elevated || spyChangePct < -1.0) {
    return {
      label:            "HIGH VOLATILITY",
      allowDirectional: false,
      allowCondors:     true,
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.5,
      otmPct:           5,      // 5% OTM strikes
      note:             `VIX ${vix} / SPY ${spyChangePct.toFixed(1)}% — income only, 5% OTM wings`,
    };
  }
  // Lowered SPY threshold from -0.5% to -0.3% — catches borderline days like July 14
  if (vix > VIX_REGIME.calm || spyChangePct < -0.3) {
    return {
      label:            "ELEVATED VOLATILITY",
      allowDirectional: false,
      allowCondors:     true,
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.25,
      otmPct:           4,      // 4% OTM strikes
      note:             `VIX ${vix} / SPY ${spyChangePct.toFixed(1)}% — income only, 4% OTM wings`,
    };
  }
  return {
    label:            "NORMAL",
    allowDirectional: true,
    allowCondors:     true,
    allowCSP:         true,
    skipTrading:      false,
    wingMultiplier:   1.0,
    otmPct:           3,        // 3% OTM strikes in calm markets
    note:             `VIX ${vix} / SPY ${spyChangePct.toFixed(1)}% — all strategies allowed, 3% OTM`,
  };
}

// ═══════════════════════════════════════════════════════════════
// SECTOR CORRELATION CHECK
// Before placing directional spreads, verify the sector isn't
// broadly weak. If 2+ semis are down 2%+, skip all semi directionals.
// ═══════════════════════════════════════════════════════════════

const SECTOR_GROUPS = {
  semis:   ["NVDA", "AMD", "AVGO"],          // Pure semiconductors only
  cyber:   ["CRWD", "PANW"],                  // Cybersecurity — separate from semis
  megacap: ["MSFT", "AAPL", "AMZN", "GOOGL", "META"],
  ev:      ["TSLA"],
  pharma:  ["LLY"],
  ai:      ["PLTR", "NOW"],
  nuclear: ["OKLO"],
  index:   ["SPY", "QQQ"],
};

function checkSectorHealth(ticker, portfolioData) {
  // Find which sector group this ticker belongs to
  const sectorEntry = Object.entries(SECTOR_GROUPS).find(([, tickers]) => tickers.includes(ticker));
  if (!sectorEntry) return { healthy: true, reason: "No sector group" };

  const [sectorName, peers] = sectorEntry;

  // Skip check for indexes and single-stock sectors
  // Skip correlation check for single-stock sectors and indexes
  if (["ev", "pharma", "nuclear", "ai", "index"].includes(sectorName)) {
    return { healthy: true, reason: "Single-stock or index sector" };
  }

  // Count how many OTHER members of this sector are down 2%+ today.
  // Threshold scales with group size so small groups (e.g. 2-member
  // "cyber": CRWD/PANW) aren't structurally unable to ever trigger —
  // requiring a fixed ">=2" would be mathematically impossible when
  // there's only 1 other peer to check. Large groups (3+ members)
  // keep the original ">=2" bar to preserve verified behavior.
  const otherPeers   = peers.filter(p => p !== ticker);
  const weakPeers    = otherPeers
    .map(p => portfolioData.find(d => d.ticker === p))
    .filter(p => p && (p.changePct || 0) < -2.0);
  const weakThreshold = Math.min(2, otherPeers.length); // 2-member group -> 1, 3+ member group -> 2

  if (weakPeers.length >= weakThreshold && weakThreshold > 0) {
    const names = weakPeers.map(p => `${p.ticker} ${p.changePct.toFixed(1)}%`).join(", ");
    return {
      healthy:          false,
      reason:           `${sectorName} sector weak — ${weakPeers.length} peers down 2%+: ${names}`,
      blockDirectional: true,
    };
  }

  return { healthy: true, reason: `${sectorName} sector OK — fewer than 2 peers down 2%+` };
}

// ═══════════════════════════════════════════════════════════════
// RETRY WRAPPER — retries Anthropic API calls on connection errors
// Handles transient Railway network blips gracefully
// ═══════════════════════════════════════════════════════════════

async function retryAI(fn, maxAttempts = 3, delayMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // Log full error details to help diagnose Railway network issues
      const errDetail = `status=${e.status || "N/A"} type=${e.constructor?.name} msg=${e.message}`;
      console.error(`  ⚠ AI attempt ${attempt} error: ${errDetail}`);

      const isRetryable = e.message.includes("Connection error") ||
                          e.message.includes("ECONNREFUSED") ||
                          e.message.includes("ENOTFOUND") ||
                          e.message.includes("fetch failed") ||
                          e.message.includes("network") ||
                          e.message.includes("timeout") ||
                          e.status === 529 ||
                          e.status === 503 ||
                          e.status === 401 || // auth errors — key issue
                          e.status === 400;   // bad request — model ID etc
      if (!isRetryable || attempt === maxAttempts) {
        console.error(`  ✗ AI call failed after ${attempt} attempt(s): ${errDetail}`);
        throw e;
      }
      const wait = delayMs * attempt;
      console.log(`  ⚠ AI call attempt ${attempt} failed — retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// AI TRADE GENERATION
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// HIGH-BETA RESTRICTION
// Lesson from Jul 14-15: NVDA directional spreads lost money both
// days (-$650, -$610) while income trades won 6/6. High-beta names
// default to income-only strategies (CSP, Iron Condor) regardless
// of regime or sector health. Directional spreads reserved for
// medium-IV, lower-beta names only.
// ═══════════════════════════════════════════════════════════════

const HIGH_BETA_TICKERS = ["NVDA", "TSLA", "CRWD"]; // 2-day loss data on NVDA directionals

// Minimum setupScore required for directional trades (Bull/Bear spreads)
// Raised from 6 to 8 — require higher conviction for directional risk
const DIRECTIONAL_MIN_SCORE = 8;
const INCOME_MIN_SCORE      = 6; // CSP, Iron Condor keep original threshold

async function generateTrades(portfolioData, preComputedRegime = null) {
  const optionable = portfolioData.filter(p => p.optionable && p.price);
  const today      = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  // ── Use pre-fetched regime if the caller already computed one this
  // session (avoids redundant VIX/SPY API calls and prevents the AI
  // prompt from describing a different regime than buildOptionsLegs uses) ──
  let vix, spyChange, regime;
  if (preComputedRegime) {
    ({ vix, spyChange, regime } = preComputedRegime);
    console.log(`  📊 Using pre-computed regime: ${regime.label} (passed from caller)`);
  } else {
    vix = 18; spyChange = 0;
    try { [vix, spyChange] = await Promise.all([fetchVIX(), fetchSPYChange()]); }
    catch(e) { console.log(`  ⚠ Market sentiment fetch failed (${e.message}) — using defaults VIX:18 SPY:0%`); }
    regime = getMarketRegime(vix, spyChange);
    console.log(`  📊 Market regime: ${regime.label} — ${regime.note}`);
  }

  // Skip trading entirely in extreme fear
  if (regime.skipTrading) {
    await sendSMS(`⚠️ OPTIONS BOT\nNo trades today — ${regime.note}\nBot resumes tomorrow.`);
    return [];
  }

  // Pre-screen each ticker for sector weakness — block directional on weak sectors
  const sectorHealth = {};
  for (const stock of optionable) {
    sectorHealth[stock.ticker] = checkSectorHealth(stock.ticker, optionable);
    if (!sectorHealth[stock.ticker].healthy) {
      console.log(`  ⚠ ${stock.ticker} sector weak: ${sectorHealth[stock.ticker].reason}`);
    }
  }
  const weakSectors = Object.entries(sectorHealth)
    .filter(([, h]) => !h.healthy)
    .map(([t, h]) => `${t}: ${h.reason}`);

  // Earnings avoidance: 14 days for directional, 7 days for income
  const earningsWarnings = Object.entries(EARNINGS)
    .map(([t,d]) => ({ t, d, days:Math.ceil((new Date(d)-new Date())/(1000*60*60*24)) }))
    .filter(e => e.days > 0 && e.days <= 14)
    .map(e => `${e.t} in ${e.days} days`);

  // Build allowed strategies based on regime
  const allowedStrategies = [];
  if (regime.allowCSP)         allowedStrategies.push("Cash Secured Put");
  if (regime.allowCondors)     allowedStrategies.push("Iron Condor");
  if (regime.allowDirectional) allowedStrategies.push("Bull Call Spread", "Bear Put Spread");

  const prompt = `You are a professional options trader. Generate ${MANDATE.tradesPerDay.min}–${MANDATE.tradesPerDay.max} options trades for today.

DATE: ${today}
MANDATE: $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax} daily | ${MANDATE.minReturnPct}%+ return | Exit at ${MANDATE.profitTargetPct}% profit | Max ${MANDATE.maxDTE} DTE

MARKET REGIME: ${regime.label}
VIX: ${vix} | SPY Day Change: ${spyChange.toFixed(2)}%
REGIME NOTE: ${regime.note}
WING WIDTH MULTIPLIER: ${regime.wingMultiplier}x (apply to all condor strikes — wider wings in high volatility)

⚠️ ALLOWED STRATEGIES TODAY: ${allowedStrategies.join(", ")}
${!regime.allowDirectional ? "🚫 DO NOT suggest Bull Call Spreads or Bear Put Spreads today — market conditions require income-only strategies" : ""}

LIVE PRICES (${optionable.length} stocks):
${optionable.map(p => {
    const health = sectorHealth[p.ticker];
    const warn = (!health?.healthy) ? " ⚠️ SECTOR WEAK" : "";
    return `${p.ticker}: $${p.price?.toFixed(2)} ${(p.changePct||0)>=0?"▲":"▼"}${Math.abs(p.changePct||0).toFixed(2)}% | IV:${p.ivProfile} | ${p.sector}${warn}`;
  }).join("\n")}

${weakSectors.length > 0 ? `⚠️ SECTOR WEAKNESS DETECTED:\n${weakSectors.join("\n")}\nDo NOT place directional spreads on tickers marked SECTOR WEAK` : "All sectors healthy"}

⚠️ HIGH-BETA RESTRICTION (data-driven from Jul 14-15 results):
${HIGH_BETA_TICKERS.join(", ")} are HIGH BETA — directional spreads (Bull Call Spread, Bear Put Spread) on these lost money 2 consecutive days.
For ${HIGH_BETA_TICKERS.join(", ")}: ONLY use Iron Condor or Cash Secured Put (income strategies). Do NOT suggest Bull Call Spread or Bear Put Spread on these tickers regardless of regime.
Minimum setupScore for ANY directional spread (on non-high-beta tickers): ${DIRECTIONAL_MIN_SCORE} (raised from 6)
Minimum setupScore for income strategies (CSP, Iron Condor): ${INCOME_MIN_SCORE}

${earningsWarnings.length ? `⚠️ EARNINGS PROXIMITY (avoid directional trades within 14 days, income trades within 7 days):\n${earningsWarnings.join(", ")}` : "No earnings this week"}

CAPITAL REMAINING TODAY: $${MANDATE.dailyCapMax - state.totalDeployedToday}

Strategy guide (only use ALLOWED STRATEGIES listed above):
- HIGH IV names (NVDA,AMD,AVGO,MSFT,TSLA,PANW,CRWD,META,AMZN,GOOGL,OKLO): Iron Condor, Cash Secured Put — sell premium (no covered calls — no share positions)
- MEDIUM IV names (AAPL,LLY,PLTR,NOW,SPY,QQQ): ${regime.allowDirectional ? "Bull Call Spread, Bear Put Spread, " : ""}Iron Condor
- Index ETFs (SPY,QQQ): best for iron condors — place short strikes ${regime.otmPct}% OTM from current price today
- All condors: short strikes must be at least ${regime.otmPct}% away from current price (${regime.wingMultiplier}x wider than baseline)
- Directional spreads: long strike no closer than ${Math.round(regime.otmPct * 0.5)}% from current price
- Avoid tickers with earnings within 7 days (income) or 14 days (directional)
- OTM distance today: ${regime.otmPct}% — place all short strikes at least this far from current price
- For tickers marked SECTOR WEAK: income strategies only (CSP or Iron Condor), no directional spreads regardless of regime

Return ONLY a valid JSON array, no markdown, no extra text.
Every object MUST include ALL of these exact field names:
[{
  "ticker": "NVDA",
  "strategy": "Bull Call Spread",
  "direction": "BULLISH",
  "targetCost": 900,
  "targetReturnPct": "10.0",
  "setupScore": 8,
  "rationale": "NVDA up 3.1% today with high IV — bull spread captures momentum",
  "exitTarget": "Close at 50% of max profit"
}]

REQUIRED FIELDS — do not rename or omit any:
- ticker: stock symbol string
- strategy: options strategy name string
- direction: BULLISH, BEARISH, or NEUTRAL
- targetCost: integer dollar amount between ${MANDATE.minPerTrade} and ${MANDATE.maxPerTrade}
- targetReturnPct: string percentage e.g. "9.5" (must be >= ${MANDATE.minReturnPct})
- setupScore: integer 1-10 (must be >= 6)
- rationale: one sentence explanation
- exitTarget: exit rule string`;

  const msg = await retryAI(() => ai.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1000,
    messages:   [{ role: "user", content: prompt }],
  }));

  // Safely collect all text blocks — msg.content[0] may not be text
  // if the model adds preamble or the response shape is unexpected
  const allText = msg.content
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("")
    .trim();

  if (!allText) throw new Error("No text block in generateTrades response");

  // Strip markdown fences if present, then extract JSON array
  const cleaned = allText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON array found in generateTrades. Raw: ${cleaned.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch(e) {
    throw new Error(`JSON parse failed in generateTrades: ${e.message}`);
  }

  // Normalise field names — model sometimes uses alternate names
  // e.g. "cost" instead of "targetCost", "score" instead of "setupScore"
  const normalised = parsed.map(t => ({
    ...t,
    targetCost:      t.targetCost      ?? t.cost        ?? t.tradeCost   ?? 0,
    targetReturnPct: t.targetReturnPct ?? t.returnPct   ?? t.return       ?? "0",
    setupScore:      t.setupScore      ?? t.score        ?? t.quality     ?? 0,
    strategy:        t.strategy        ?? t.type         ?? t.tradeType   ?? "Unknown",
    direction:       t.direction       ?? t.bias         ?? "NEUTRAL",
    rationale:       t.rationale       ?? t.reason       ?? t.explanation ?? "",
    exitTarget:      t.exitTarget      ?? t.exitRule     ?? t.exit        ?? "",
  }));

  const isDirectional = (strategy) => ["Bull Call Spread", "Bear Put Spread"].includes(strategy);

  const passed = normalised.filter(t => {
    // Basic mandate checks
    if (t.targetCost < MANDATE.minPerTrade || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) return false;

    // High-beta names: block directional spreads entirely regardless of score
    if (isDirectional(t.strategy) && HIGH_BETA_TICKERS.includes(t.ticker)) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — high-beta ticker, income-only`);
      return false;
    }

    // Directional trades need higher conviction (setupScore >= 8)
    const minScore = isDirectional(t.strategy) ? DIRECTIONAL_MIN_SCORE : INCOME_MIN_SCORE;
    if (t.setupScore < minScore) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — score ${t.setupScore} below ${minScore} minimum`);
      return false;
    }

    return true;
  });

  if (passed.length === 0 && normalised.length > 0) {
    console.log(`  ⚠ All ${normalised.length} trades filtered out. Scores: ${normalised.map(t=>t.setupScore).join(",")}, Costs: ${normalised.map(t=>t.targetCost).join(",")}, Returns: ${normalised.map(t=>t.targetReturnPct).join(",")}`);
  }

  return passed;
}

// ═══════════════════════════════════════════════════════════════
// ALERT DETECTION
// ═══════════════════════════════════════════════════════════════

function detectAlerts(stock, priceData) {
  const alerts         = [];
  const price          = priceData.price;
  const effectiveStop  = getStopLoss(stock.ticker, stock.stopLoss);
  const effectiveTarget= getTarget(stock.ticker, stock.target);

  // Update trailing stop on every check
  if (stock.optionable && price && effectiveStop) {
    updateTrailingStop(stock.ticker, price, effectiveStop);
  }

  if (effectiveStop && price <= effectiveStop) {
    alerts.push({ type:"STOP_LOSS", urgency:"🚨 CRITICAL", msg:`$${price.toFixed(2)} hit stop-loss $${effectiveStop.toFixed(2)}. Exit or hedge immediately.` });
  } else if (effectiveStop && price <= effectiveStop * 1.05) {
    alerts.push({ type:"STOP_WARNING", urgency:"⚠️ WARNING", msg:`$${price.toFixed(2)} within 5% of stop-loss $${effectiveStop.toFixed(2)}.` });
  }
  if (effectiveTarget && price >= effectiveTarget) {
    alerts.push({ type:"TARGET_HIT", urgency:"🎯 TARGET", msg:`$${price.toFixed(2)} reached target $${effectiveTarget.toFixed(2)}. Consider covered calls or trimming.` });
  }
  const absPct = Math.abs(priceData.changePct || 0);
  if (absPct >= 6) {
    alerts.push({ type:"BIG_MOVE", urgency:`${priceData.changePct>0?"🚀":"📉"} ${absPct.toFixed(1)}%`, msg:`Large move — IV likely elevated, options opportunity.` });
  }
  const earningsDate = EARNINGS[stock.ticker];
  if (earningsDate) {
    const days = Math.ceil((new Date(earningsDate)-new Date())/(1000*60*60*24));
    if ([7,3,1].includes(days)) {
      alerts.push({ type:"EARNINGS", urgency:"📅 EARNINGS", msg:`Reports in ${days} day${days===1?"":"s"} (${earningsDate}). Close or roll options before then.` });
    }
  }
  return alerts;
}

// ═══════════════════════════════════════════════════════════════
// POSITION MONITOR — auto-close at profit target or stop
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// LIVE POSITION SNAPSHOT
// Pulls real-time value for every open position directly from
// Tradier's quote API — ground truth, never estimated or stale.
// Sent automatically at end of each intraday check when positions
// are open, so you always have an accurate, verifiable P&L.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// MULTI-LEG POSITION GROUPING
// Tradier reports each option leg as its own position row. This
// helper groups those rows back into the ORIGINAL multi-leg trade
// (Iron Condor = 4 legs, spreads = 2 legs, CSP = 1 leg) and computes
// the NET live value across all legs — never treats a single leg's
// price as if it were the whole spread's value.
// ═══════════════════════════════════════════════════════════════

async function getGroupedLivePositions() {
  const positions = await getTradierPositions();
  if (!positions.length) return [];

  // Build a quote lookup for every leg symbol in one batch call
  const allSymbols = positions.map(p => p.symbol);
  const quotes     = await getOptionQuote(allSymbols);
  const quoteMap   = {};
  for (const q of quotes) quoteMap[q.symbol] = q;

  // Group Tradier position rows by which internal trade they belong to
  const grouped = new Map(); // ourTrade -> { positions: [...], legValue: number }

  for (const pos of positions) {
    const ourTrade = state.openPositions.find(t => t.legs?.some(l => l.symbol === pos.symbol));
    if (!ourTrade) continue; // untracked position — skip, don't misattribute

    if (!grouped.has(ourTrade)) grouped.set(ourTrade, { positions: [], netValue: 0, missingQuote: false });
    const g = grouped.get(ourTrade);
    g.positions.push(pos);

    const quote = quoteMap[pos.symbol];
    if (!quote) { g.missingQuote = true; continue; }

    const legMid = (quote.bid + quote.ask) / 2;
    // Sign each leg correctly: a SHORT leg (negative Tradier quantity,
    // i.e. we sold to open) subtracts from net spread value; a LONG
    // leg (positive quantity, we bought to open) adds to it. This
    // reconstructs the true net debit/credit value of the whole spread.
    const legSign = pos.quantity > 0 ? 1 : -1;
    g.netValue += legSign * legMid;
  }

  // Convert to array with computed P&L per GROUPED trade (not per leg)
  const results = [];
  for (const [ourTrade, g] of grouped.entries()) {
    if (g.missingQuote) {
      results.push({ ourTrade, positions: g.positions, valid: false });
      continue;
    }
    const qty = Math.abs(g.positions[0]?.quantity || 1);
    // netValue is signed per-leg-role during accumulation (long +, short -),
    // which converges to the correct "cost to close today" for BOTH debit
    // and credit spreads once we take the absolute value here.
    const currentValue = Math.abs(g.netValue);
    results.push({ ourTrade, positions: g.positions, valid: true, currentValue, qty });
  }
  return results;
}

async function getLivePositionSnapshot() {
  const groups = await getGroupedLivePositions();
  if (!groups.length) {
    return { hasPositions: false, summary: "No open positions.", totalPnL: 0, lines: [] };
  }

  const lines = [];
  let totalPnL = 0;
  let totalCost = 0;

  // One line per TRADE (all legs combined), never per individual leg
  for (const g of groups) {
    const { ourTrade } = g;
    if (!g.valid) {
      lines.push(`${ourTrade.ticker} ${ourTrade.strategy}: ⚠️ quote unavailable for one or more legs`);
      continue;
    }

    const openCost   = ourTrade.executedCost / g.qty / 100; // per-share cost basis of the WHOLE spread
    const currentPnL = ourTrade.isCredit
      ? (openCost - g.currentValue) * g.qty * 100   // credit trade: profit as spread value decays toward 0
      : (g.currentValue - openCost) * g.qty * 100;  // debit trade: profit as spread value rises
    const currentPct = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;

    totalPnL  += currentPnL;
    totalCost += ourTrade.executedCost;

    lines.push(
      `${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} leg${g.positions.length>1?"s":""}): $${ourTrade.executedCost} → ` +
      `${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct>=0?"+":""}${currentPct.toFixed(1)}%) — VERIFIED live`
    );
  }

  return {
    hasPositions: true,
    totalPnL,
    totalCost,
    totalPct: totalCost ? (totalPnL / totalCost * 100) : 0,
    lines,
    timestamp: new Date().toISOString(),
  };
}

async function sendLiveSnapshot() {
  const snap = await getLivePositionSnapshot();

  if (!snap.hasPositions) {
    await sendSMS(`📊 LIVE SNAPSHOT\n${new Date().toLocaleTimeString()}\n\nNo open positions.\nAll data verified via Tradier live quotes.`);
    return snap;
  }

  await sendSMS(
`📊 LIVE POSITION SNAPSHOT
${new Date().toLocaleTimeString()} — VERIFIED (Tradier live quotes)

${snap.lines.join("\n")}

TOTAL: ${snap.totalPnL>=0?"+":""}$${snap.totalPnL.toFixed(0)} (${snap.totalPct>=0?"+":""}${snap.totalPct.toFixed(1)}%)
Deployed: $${snap.totalCost}

Not financial advice.`
  );
  return snap;
}

async function monitorOpenPositions() {
  const groups = await getGroupedLivePositions();
  if (!groups.length) return;
  console.log(`  Monitoring ${groups.length} open trade(s) (grouped by all legs)...`);

  for (const g of groups) {
    const { ourTrade } = g;
    try {
      if (!g.valid) {
        console.log(`  ⚠ ${ourTrade.ticker} ${ourTrade.strategy}: quote unavailable for one or more legs — skipping this cycle`);
        continue;
      }

      const openCost      = ourTrade.executedCost / g.qty / 100;      // per-share cost basis of the WHOLE spread
      const maxProfitShare = ourTrade.maxProfit / g.qty / 100;
      const currentPnL     = ourTrade.isCredit
        ? (openCost - g.currentValue) * g.qty * 100   // credit trade: profit as value decays toward 0
        : (g.currentValue - openCost) * g.qty * 100;  // debit trade: profit as value rises
      const currentPct     = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;
      const profitTargetPnL = maxProfitShare * g.qty * 100 * (MANDATE.profitTargetPct / 100);
      const expDate        = new Date(ourTrade.expiration);
      const dte            = Math.ceil((expDate - new Date()) / (1000*60*60*24));

      console.log(`  ${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs): net value $${g.currentValue.toFixed(2)}/sh | P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%) | DTE:${dte}`);

      // Credit strategies (Iron Condor, CSP) need their OWN stop-loss.
      // Standard professional heuristic: close a credit spread when the
      // loss reaches 2x the credit received (200% of max profit) — this
      // caps the damage well before reaching true max loss, which for a
      // 4-wide Iron Condor wing can be 5-10x the credit collected.
      // Both stop-loss thresholds now driven entirely by MANDATE — no
      // hardcoded percentages, so both are tunable from one place.
      const debitStopLossPnL  = -(ourTrade.executedCost * (MANDATE.stopLossPct / 100));
      const creditStopLossPnL = -(maxProfitShare * g.qty * 100 * (MANDATE.creditStopLossPct / 100));

      // BREACHED STRIKE CHECK — Lesson from PANW (Jul): an Iron Condor can
      // still be inside the dollar stop-loss threshold while the underlying
      // has already traded beyond a short strike, at which point the trade
      // is structurally compromised and rarely recovers. This checks the
      // LIVE underlying price (not just P&L) and closes immediately if
      // either short strike has been breached, regardless of dollar loss.
      let strikeBreached = false;
      if (ourTrade.strategy === "Iron Condor" && ourTrade.shortCallStrike && ourTrade.shortPutStrike) {
        const liveStock = await fetchStockPrice(ourTrade.ticker);
        if (liveStock?.price) {
          if (liveStock.price >= ourTrade.shortCallStrike) {
            strikeBreached = true;
            console.log(`  🚨 ${ourTrade.ticker} price $${liveStock.price} breached short CALL strike $${ourTrade.shortCallStrike}`);
          } else if (liveStock.price <= ourTrade.shortPutStrike) {
            strikeBreached = true;
            console.log(`  🚨 ${ourTrade.ticker} price $${liveStock.price} breached short PUT strike $${ourTrade.shortPutStrike}`);
          }
        }
      }

      let shouldClose = false, closeReason = "";
      if (strikeBreached)                { shouldClose=true; closeReason=`🚨 STRIKE BREACHED — underlying moved past a short strike, closing before further loss`; }
      else if (currentPnL >= profitTargetPnL) { shouldClose=true; closeReason=`🎯 PROFIT TARGET — ${currentPct.toFixed(1)}% gain = +$${currentPnL.toFixed(0)}`; }
      else if (dte <= MANDATE.minDTE)    { shouldClose=true; closeReason=`📅 EXPIRY RISK — ${dte} DTE, closing to avoid assignment`; }
      else if (!ourTrade.isCredit && currentPnL <= debitStopLossPnL)  { shouldClose=true; closeReason=`🛑 STOP LOSS — down ${MANDATE.stopLossPct}%+ of debit = -$${Math.abs(currentPnL).toFixed(0)}`; }
      else if (ourTrade.isCredit  && currentPnL <= creditStopLossPnL) { shouldClose=true; closeReason=`🛑 CREDIT STOP LOSS — down ${MANDATE.creditStopLossPct}%+ of credit = -$${Math.abs(currentPnL).toFixed(0)}`; }

      if (shouldClose) {
        // Close EVERY leg of this trade together — never leave a partial spread open
        const closeResults = [];
        for (const pos of g.positions) {
          const result = await closeOptionsPosition({ symbol:pos.symbol, underlyingSymbol:ourTrade.ticker, quantity:Math.abs(pos.quantity), side:pos.quantity>0?"buy_to_open":"sell_to_open" });
          closeResults.push(result);
          await new Promise(r => setTimeout(r, 300));
        }
        const allClosed = closeResults.every(r => r.success);
        if (allClosed) {
          state.dailyPnL += currentPnL;
          state.openPositions = state.openPositions.filter(t => t !== ourTrade);
          await sendSMS(`◈ POSITION CLOSED\n${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs closed)\n${closeReason}\n\nP&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%)\nToday's P&L: ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}\n\nNot financial advice.`);
        } else {
          // CRITICAL: some legs failed to close — do NOT remove from tracking.
          // Keep monitoring so we retry closing the remaining legs next cycle.
          const failedCount = closeResults.filter(r => !r.success).length;
          console.error(`  🚨 PARTIAL CLOSE FAILURE: ${failedCount}/${g.positions.length} legs failed to close on ${ourTrade.ticker}. Trade remains tracked for retry.`);
          await sendSMS(`🚨 PARTIAL CLOSE ALERT\n${ourTrade.ticker} ${ourTrade.strategy}\n${failedCount} of ${g.positions.length} legs failed to close.\nBot will retry next cycle. Check Tradier sandbox manually if this repeats.`);
        }
      }
    } catch(e) { console.error(`  ✗ Monitor ${ourTrade?.ticker || "unknown"}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ═══════════════════════════════════════════════════════════════
// ANALYST TARGET AUTO-UPDATE (runs daily 9:15 AM)
// ═══════════════════════════════════════════════════════════════

// ── ETF tickers — use price-based levels, not analyst targets ──
const ETF_TICKERS = ["SPY", "QQQ", "XLE", "IWM", "DIA"];
const STOCK_TICKERS = PORTFOLIO
  .filter(p => p.optionable && !ETF_TICKERS.includes(p.ticker))
  .map(p => p.ticker);

async function updateAllPricingLevels(portfolioData) {
  console.log("\n📊 Auto-updating ALL pricing levels...");
  let totalUpdated = 0;

  // ── STEP 1: ETF price-based update ─────────────────────────
  // ETFs have no analyst targets — derive stop (10% below) and target (10% above)
  // Quick split pre-check — flag any stock where live price is 40%+ below stored cost
  // Full verification runs Sunday via detectAndFixSplits
  for (const stock of PORTFOLIO) {
    const live = portfolioData.find(p => p.ticker === stock.ticker);
    if (!live?.price) continue;
    const stored = getStopLoss(stock.ticker, stock.stopLoss) * (1/0.85); // approximate cost from stop
    const drop   = (stock.avgCost - live.price) / stock.avgCost;
    if (drop > 0.40) {
      const ratio = detectLikelySplitRatio(stock.avgCost, live.price);
      if (ratio) console.log(`  ⚠ ${stock.ticker} possible ${ratio}-for-1 split — price $${live.price} vs stored $${stock.avgCost}. Will verify Sunday.`);
    }
  }
  console.log("  Updating ETF levels (price-based)...");
  for (const ticker of ETF_TICKERS) {
    const liveData = portfolioData.find(p => p.ticker === ticker);
    if (!liveData?.price) continue;
    const price     = liveData.price;
    const newStop   = parseFloat((price * 0.90).toFixed(2));
    const newTarget = parseFloat((price * 1.10).toFixed(2));
    const stock     = PORTFOLIO.find(p => p.ticker === ticker);
    const oldStop   = getStopLoss(ticker, stock?.stopLoss);
    const oldTarget = getTarget(ticker, stock?.target);
    const effectiveStop = Math.max(newStop, oldStop || 0);
    state.dynamicLevels[ticker] = {
      ...(state.dynamicLevels[ticker] || {}),
      stopLoss: effectiveStop, target: newTarget,
      lastUpdated: new Date().toISOString(), source: "price-based auto",
    };
    console.log(`  ✓ ${ticker}: $${price} | stop $${oldStop}→$${effectiveStop} | target $${oldTarget}→$${newTarget}`);
    totalUpdated++;
  }

  // ── STEP 2: Stock analyst consensus update ──────────────────
  console.log("  Fetching analyst targets for stocks...");
  const prompt = `Search the web for current analyst consensus 12-month price targets for these stocks as of today:
${STOCK_TICKERS.join(", ")}

Search Yahoo Finance, Stockanalysis.com, MarketBeat, or TipRanks for each ticker.

Return ONLY a JSON array, no markdown:
[{"ticker":"NVDA","currentPrice":209,"analystTarget":245,"numAnalysts":42,"source":"Yahoo Finance"}]

Include every ticker. Use null for analystTarget if no data found.`;

  // Retry wrapper — up to 3 attempts with exponential backoff
  // Handles transient Railway network errors on outbound Anthropic API calls
  const fetchWithRetry = async (attempt = 1) => {
    try {
      return await ai.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 2000,
        tools:      [{ type: "web_search_20250305", name: "web_search" }],
        messages:   [{ role: "user", content: prompt }],
      });
    } catch (err) {
      if (attempt < 3) {
        const delay = attempt * 5000; // 5s, 10s
        console.log(`  ⚠ Analyst fetch attempt ${attempt} failed: ${err.message}. Retrying in ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        return fetchWithRetry(attempt + 1);
      }
      throw err;
    }
  };

  try {
    const msg = await fetchWithRetry();
    // Collect ALL content blocks — model returns tool_use blocks first,
    // then a final text block with the JSON. Filter for text only after
    // all tool calls complete. Handle empty text gracefully.
    const allText = msg.content
      .filter(b => b.type === "text")
      .map(b => b.text || "")
      .join("")
      .trim();

    if (!allText) {
      console.log("  ⚠ No text block in response — model may have returned tool_use only. Skipping update.");
      return totalUpdated;
    }

    // Extract JSON array from anywhere in the text response
    const match = allText.match(/\[[\s\S]*?\]/);
    if (!match) {
      console.log("  ⚠ No JSON array found in response. Raw text:", allText.slice(0, 200));
      return totalUpdated;
    }

    let results;
    try {
      results = JSON.parse(match[0]);
    } catch(parseErr) {
      console.error("  ✗ JSON parse failed:", parseErr.message);
      return totalUpdated;
    }
    for (const r of results) {
      if (!r.ticker || !r.analystTarget) continue;
      const stock        = PORTFOLIO.find(p => p.ticker === r.ticker);
      if (!stock) continue;
      const liveData     = portfolioData.find(p => p.ticker === r.ticker);
      const currentPrice = liveData?.price || r.currentPrice || stock.avgCost;
      const oldTarget    = getTarget(r.ticker, stock.target);
      const oldStop      = getStopLoss(r.ticker, stock.stopLoss);
      const targetChanged = Math.abs(r.analystTarget - oldTarget) / oldTarget > 0.03;
      const priceBasedStop = parseFloat((currentPrice * 0.85).toFixed(2));
      const newStop        = Math.max(priceBasedStop, oldStop || 0);
      const stopChanged    = newStop > oldStop;
      if (targetChanged || stopChanged) {
        state.dynamicLevels[r.ticker] = {
          ...(state.dynamicLevels[r.ticker] || {}),
          ...(targetChanged ? { target: r.analystTarget, targetSource: r.source, numAnalysts: r.numAnalysts } : {}),
          ...(stopChanged   ? { stopLoss: newStop } : {}),
          lastUpdated: new Date().toISOString(),
        };
        const changes = [];
        if (targetChanged) changes.push(`target $${oldTarget}→$${r.analystTarget} (${r.numAnalysts} analysts)`);
        if (stopChanged)   changes.push(`stop $${oldStop}→$${newStop}`);
        console.log(`  ✓ ${r.ticker}: ${changes.join(" | ")}`);
        totalUpdated++;
      }
    }
  } catch(e) { console.error(`  ✗ Analyst fetch failed: ${e.message}`); }

  console.log(`  ✅ Auto-update complete: ${totalUpdated} positions updated`);
  return totalUpdated;
}

// Alias — keeps daily 9:15 AM cron working
async function updateAnalystTargets() {
  const portfolioData = await fetchAllPrices();
  // Check for splits FIRST — must happen before pricing update
  await detectAndFixSplits(portfolioData);
  await updateAllPricingLevels(portfolioData);
}


async function morningSession() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🌅 Morning session...`);
  state.dailyTrades = []; state.totalDeployedToday = 0; state.dailyPnL = 0;

  // Wrap all external calls in try/catch — any single failure
  // should not kill the entire morning session
  let balances = {};
  try { balances = await getAccountBalances(); } catch(e) { console.log(`  ⚠ Balances unavailable: ${e.message}`); }
  const buyingPower = balances?.option_buying_power || balances?.cash || 0;

  const portfolioData = await fetchAllPrices();
  const modeFlag      = TRADIER.sandbox ? " [SANDBOX]" : "";

  // VIX and SPY change — fail gracefully to defaults if connection error
  let vixNow = 18, spyNow = 0;
  try { vixNow = await fetchVIX(); }      catch(e) { console.log(`  ⚠ VIX unavailable — defaulting to 18`); }
  try { spyNow = await fetchSPYChange(); } catch(e) { console.log(`  ⚠ SPY change unavailable — defaulting to 0`); }
  const regimeNow = getMarketRegime(vixNow, spyNow);
  console.log(`  📊 Regime: ${regimeNow.label} | VIX: ${vixNow} | SPY: ${spyNow.toFixed(2)}%`);

  // Generate trades — retry up to 3x on connection errors
  let trades = [];
  let scanAttempt = 0;
  while (scanAttempt < 3 && trades.length === 0) {
    scanAttempt++;
    try {
      trades = await generateTrades(portfolioData, { vix: vixNow, spyChange: spyNow, regime: regimeNow });
    } catch(e) {
      const isRetryable = e.message.includes("Connection error") ||
                          e.message.includes("ECONNREFUSED") ||
                          e.message.includes("fetch failed") ||
                          e.message.includes("network");
      if (!isRetryable || scanAttempt === 3) {
        await sendSMS(`⚠️ Morning scan failed after ${scanAttempt} attempt(s): ${e.message}`);
        return;
      }
      const wait = scanAttempt * 30000; // 30s, 60s between morning retries
      console.log(`  ⚠ Morning scan attempt ${scanAttempt} failed — retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  const executed = [];
  for (const trade of trades) {
    if (state.totalDeployedToday >= MANDATE.dailyCapMax) break;
    const stockData = portfolioData.find(p => p.ticker === trade.ticker);
    if (!stockData?.price) continue;

    const legs = await buildOptionsLegs(trade, stockData.price, regimeNow);
    if (!legs) { console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — buildOptionsLegs returned null, skipping (see rejection reason above)`); continue; }
    if (legs.cost < MANDATE.minPerTrade || legs.cost > MANDATE.maxPerTrade) {
      console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — cost $${legs.cost} outside mandate range $${MANDATE.minPerTrade}-$${MANDATE.maxPerTrade}, skipping`);
      continue;
    }

    const result = await placeOptionsOrder({ ticker:trade.ticker, strategy:trade.strategy, legs:legs.legs, quantity:legs.quantity || 1 });
    // Only log success and track position if the order actually succeeded.
    // Sandbox mode still requires a real successful API response — do not
    // treat sandbox as auto-success when Tradier rejects the order.
    if (result.success) {
      const ex = { ...trade, ...legs, orderId:result.orderId||"SANDBOX", executedAt:new Date().toISOString(), executedCost:legs.cost, executedPrice:stockData.price, status:"OPEN" };
      executed.push(ex);
      state.openPositions.push(ex);
      state.dailyTrades.push(ex);
      state.totalDeployedToday += legs.cost;
      console.log(`  ✅ ${trade.ticker} ${trade.strategy} — $${legs.cost}`);
    } else {
      console.log(`  ✗ ${trade.ticker} ${trade.strategy} — order rejected: ${result.error}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  const regimeFlag = regimeNow.label !== "NORMAL" ? `\nRegime: ${regimeNow.label} (VIX ${vixNow})` : "";
  const msg = executed.length > 0
    ? `◈ MORNING${modeFlag}${regimeFlag} ${new Date().toLocaleDateString()}\n\n${executed.length} TRADES EXECUTED:\n${executed.map((t,i)=>`${i+1}. ${t.ticker} ${t.strategy}\n   Cost: $${t.executedCost} | Target: ${t.targetReturnPct}%\n   Expiry: ${t.expiration} | Order: ${t.orderId}`).join("\n\n")}\n\nDeployed: $${state.totalDeployedToday}\nMonitoring every 20 min. Auto-close at ${MANDATE.profitTargetPct}% profit.\n\nNot financial advice.`
    : `◈ MORNING${modeFlag} ${new Date().toLocaleDateString()}\n\nNo trades executed — no setups met the 8% mandate.\nMonitoring continues.\n\nNot financial advice.`;
  await sendSMS(msg);
}

// ═══════════════════════════════════════════════════════════════
// OPPORTUNISTIC MID-DAY SCAN
// Runs every 2 hours during market hours (11 AM, 1 PM, 3 PM ET).
// Only opens a NEW trade if:
//   1. Daily capital budget has room remaining
//   2. A genuinely exceptional setup exists (big move + elevated IV)
//   3. Max 1 opportunistic trade per scan — stays disciplined
// This captures real-time opportunities (like a stock dropping 5%+
// with rich premium) without turning the bot into a high-frequency
// system. Respects all existing regime, sector, and high-beta rules.
// ═══════════════════════════════════════════════════════════════

async function opportunisticScan() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🔍 Opportunistic scan...`);

  const budgetRemaining = MANDATE.dailyCapMax - state.totalDeployedToday;
  if (budgetRemaining < MANDATE.minPerTrade) {
    console.log(`  ⏭  Skipping — daily budget exhausted ($${state.totalDeployedToday} deployed, $${budgetRemaining} remaining)`);
    return;
  }

  // Don't over-trade — cap opportunistic entries separately from morning trades
  const opportunisticToday = state.dailyTrades.filter(t => t.source === "opportunistic").length;
  if (opportunisticToday >= 2) {
    console.log(`  ⏭  Skipping — already placed ${opportunisticToday} opportunistic trades today (max 2)`);
    return;
  }

  const portfolioData = await fetchAllPrices();

  // Look for exceptional setups: big move (5%+) — these create rich premium
  const exceptionalMoves = portfolioData.filter(p =>
    p.optionable && p.price && Math.abs(p.changePct || 0) >= 5.0
  );

  if (!exceptionalMoves.length) {
    console.log(`  ✓ No exceptional setups right now (need 5%+ move). Nothing to do.`);
    return;
  }

  console.log(`  🎯 Found ${exceptionalMoves.length} exceptional move(s): ${exceptionalMoves.map(p=>`${p.ticker} ${p.changePct.toFixed(1)}%`).join(", ")}`);

  // Re-check regime and sector health — same rules as morning session
  let vixNow = 18, spyNow = 0;
  try { vixNow = await fetchVIX(); } catch(e) {}
  try { spyNow = await fetchSPYChange(); } catch(e) {}
  const regime = getMarketRegime(vixNow, spyNow);

  if (regime.skipTrading) {
    console.log(`  ⏭  Skipping — regime is ${regime.label}, no new trades`);
    return;
  }

  // Generate a trade recommendation using the same AI + mandate logic
  let trades = [];
  try {
    trades = await generateTrades(portfolioData, { vix: vixNow, spyChange: spyNow, regime });
  } catch(e) {
    console.log(`  ✗ Opportunistic scan generation failed: ${e.message}`);
    return;
  }

  // Only take the SINGLE best-scoring trade from an exceptional mover
  const candidate = trades
    .filter(t => exceptionalMoves.some(m => m.ticker === t.ticker))
    .sort((a,b) => b.setupScore - a.setupScore)[0];

  if (!candidate) {
    console.log(`  ✓ AI found no qualifying setup among exceptional movers. Standing down.`);
    return;
  }

  const stockData = portfolioData.find(p => p.ticker === candidate.ticker);
  const legs = await buildOptionsLegs(candidate, stockData.price, regime);
  if (!legs || legs.cost < MANDATE.minPerTrade || legs.cost > MANDATE.maxPerTrade || legs.cost > budgetRemaining) {
    console.log(`  ✗ ${candidate.ticker} setup did not pass final checks. Standing down.`);
    return;
  }

  const result = await placeOptionsOrder({ ticker:candidate.ticker, strategy:candidate.strategy, legs:legs.legs, quantity:legs.quantity || 1 });

  if (result.success) {
    const ex = { ...candidate, ...legs, orderId:result.orderId, executedAt:new Date().toISOString(), executedCost:legs.cost, executedPrice:stockData.price, status:"OPEN", source:"opportunistic" };
    state.openPositions.push(ex);
    state.dailyTrades.push(ex);
    state.totalDeployedToday += legs.cost;

    await sendSMS(
`🎯 OPPORTUNISTIC TRADE
${candidate.ticker} ${(stockData.changePct>=0?"▲":"▼")}${Math.abs(stockData.changePct).toFixed(1)}% move triggered scan

${candidate.strategy}
Cost: $${legs.cost} | Target: ${candidate.targetReturnPct}%
Rationale: ${candidate.rationale}

Deployed today: $${state.totalDeployedToday} / $${MANDATE.dailyCapMax}
Not financial advice.`
    );
    console.log(`  ✅ Opportunistic trade placed: ${candidate.ticker} ${candidate.strategy} — $${legs.cost}`);
  } else {
    console.log(`  ✗ Order failed: ${result.error}`);
  }
}

async function intradayCheck() {
  console.log(`\n[${new Date().toLocaleTimeString()}] ⚡ Intraday check...`);
  await monitorOpenPositions();

  // Send a verified live snapshot if positions are open — ground truth,
  // not estimated. Only sends if there's something open to report.
  if (state.openPositions.length > 0) {
    console.log(`  📊 Sending live snapshot for ${state.openPositions.length} open position(s)...`);
    await sendLiveSnapshot();
  }

  const portfolioData = await fetchAllPrices();
  for (const stock of portfolioData) {
    if (!stock.price) continue;
    const alerts = detectAlerts(stock, stock);
    const urgent = alerts.filter(a => ["STOP_LOSS","STOP_WARNING","BIG_MOVE","EARNINGS","TARGET_HIT"].includes(a.type));
    if (!urgent.length) continue;
    const key = `${stock.ticker}_${urgent.map(a=>a.type).join("_")}_${new Date().getHours()}`;
    if (state.alertsSent.has(key)) continue;
    state.alertsSent.add(key);
    await sendSMS(`⚡ ${stock.ticker} ALERT\nPrice: $${stock.price.toFixed(2)} ${(stock.changePct||0)>=0?"▲":"▼"}${Math.abs(stock.changePct||0).toFixed(2)}%\n\n${urgent.map(a=>`${a.urgency}\n${a.msg}`).join("\n\n")}\n\nStop: $${getStopLoss(stock.ticker,stock.stopLoss)?.toFixed(2)||"N/A"} | Target: $${getTarget(stock.ticker,stock.target)?.toFixed(2)||"N/A"}\nNot financial advice.`);
    console.log(`  ✅ Alert: ${stock.ticker} — ${urgent.map(a=>a.type).join(", ")}`);
  }
  console.log(`  ✓ Check complete. Open positions: ${state.openPositions.length}`);
}

async function closingSession() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🔔 Closing session...`);
  const portfolioData = await fetchAllPrices();
  const winners  = portfolioData.filter(p=>(p.changePct||0)>0).sort((a,b)=>b.changePct-a.changePct);
  const losers   = portfolioData.filter(p=>(p.changePct||0)<0).sort((a,b)=>a.changePct-b.changePct);
  const modeFlag = TRADIER.sandbox ? " [SANDBOX]" : "";

  await sendSMS(`🔔 CLOSING${modeFlag} ${new Date().toLocaleDateString()}\n\nOPTIONS:\nTrades: ${state.dailyTrades.length} | Open: ${state.openPositions.length}\nRealized P&L: ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}\nDeployed: $${state.totalDeployedToday}\n\nSTOCKS:\n🟢 ${winners.slice(0,3).map(p=>`${p.ticker} +${(p.changePct||0).toFixed(1)}%`).join(", ")||"None"}\n🔴 ${losers.slice(0,3).map(p=>`${p.ticker} ${(p.changePct||0).toFixed(1)}%`).join(", ")||"None"}\n\nNot financial advice.`);
  state.alertsSent.clear();
  console.log("  ✅ Closing summary sent.");
}

// ═══════════════════════════════════════════════════════════════
// SPLIT DETECTION — runs every Sunday, catches stock splits
// Compares live price against stored avgCost — if price is
// dramatically lower (e.g. 75%+ drop) it flags a likely split
// and auto-adjusts avgCost, stopLoss, and target accordingly
// ═══════════════════════════════════════════════════════════════

const COMMON_SPLIT_RATIOS = [2, 3, 4, 5, 10]; // most common split ratios

function detectLikelySplitRatio(storedCost, currentPrice) {
  for (const ratio of COMMON_SPLIT_RATIOS) {
    const adjustedCost = storedCost / ratio;
    const pctDiff = Math.abs(currentPrice - adjustedCost) / adjustedCost;
    // Within 15% of adjusted price = likely that split ratio
    if (pctDiff < 0.15) return ratio;
  }
  return null;
}

async function detectAndFixSplits(portfolioData) {
  console.log("\n🔀 Checking for stock splits...");
  const splitAlerts = [];

  for (const stock of portfolioData) {
    if (!stock.price || !stock.avgCost) continue;
    const livePrice  = stock.price;
    const storedCost = state.dynamicLevels[stock.ticker]?.avgCost || stock.avgCost;

    // Only check if live price is dramatically LOWER than stored cost
    // A split would make price look lower vs our stored pre-split cost
    const priceDrop = (storedCost - livePrice) / storedCost;
    if (priceDrop < 0.40) continue; // less than 40% drop — probably not a split

    // Try to match to a common split ratio
    const ratio = detectLikelySplitRatio(storedCost, livePrice);
    if (!ratio) continue;

    // Verify via AI web search before acting
    const verifyPrompt = `Search the web: has ${stock.ticker} (${stock.name}) done a stock split in the last 90 days? 
If yes, what was the split ratio (e.g. 2-for-1, 4-for-1)?
Return ONLY JSON: {"splitDetected": true, "ratio": 4, "date": "2026-07-01", "source": "Yahoo Finance"}
If no split found: {"splitDetected": false}`;

    try {
      const msg = await retryAI(() => ai.messages.create({
        model:     "claude-sonnet-4-6",
        max_tokens: 300,
        tools:     [{ type: "web_search_20250305", name: "web_search" }],
        messages:  [{ role: "user", content: verifyPrompt }],
      }));

      const text  = msg.content.filter(b => b.type === "text").map(b => b.text || "").join("").trim();
      const match = text.match(/\{[\s\S]*?\}/);
      if (!match) continue;

      const result = JSON.parse(match[0]);
      if (!result.splitDetected || !result.ratio) continue;

      const confirmedRatio = result.ratio;

      // Auto-adjust all stored levels
      const newAvgCost  = parseFloat((storedCost    / confirmedRatio).toFixed(2));
      const oldStop     = getStopLoss(stock.ticker, stock.stopLoss);
      const oldTarget   = getTarget(stock.ticker, stock.target);
      const newStop     = parseFloat((oldStop   / confirmedRatio).toFixed(2));
      const newTarget   = parseFloat((oldTarget / confirmedRatio).toFixed(2));

      state.dynamicLevels[stock.ticker] = {
        ...(state.dynamicLevels[stock.ticker] || {}),
        avgCost:     newAvgCost,
        stopLoss:    newStop,
        target:      newTarget,
        splitRatio:  confirmedRatio,
        splitDate:   result.date,
        lastUpdated: new Date().toISOString(),
      };

      console.log(`  🔀 ${stock.ticker} ${confirmedRatio}-for-1 split confirmed (${result.date})`);
      console.log(`     avgCost: $${storedCost} → $${newAvgCost}`);
      console.log(`     stop:    $${oldStop}    → $${newStop}`);
      console.log(`     target:  $${oldTarget}  → $${newTarget}`);

      splitAlerts.push({
        ticker:    stock.ticker,
        ratio:     confirmedRatio,
        date:      result.date,
        newCost:   newAvgCost,
        newStop,
        newTarget,
      });

    } catch(e) {
      console.error(`  ✗ Split check failed for ${stock.ticker}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  if (splitAlerts.length > 0) {
    const alertMsg = splitAlerts.map(s =>
      `${s.ticker}: ${s.ratio}-for-1 split (${s.date})\nNew cost: $${s.newCost} | Stop: $${s.newStop} | Target: $${s.newTarget}`
    ).join("\n\n");

    await sendSMS(
`🔀 SPLIT DETECTED & AUTO-FIXED
${new Date().toLocaleDateString()}

${alertMsg}

All levels automatically adjusted.
No action needed.
Not financial advice.`
    );
  } else {
    console.log("  ✓ No splits detected");
  }

  return splitAlerts;
}

async function sundaySummary() {
  console.log("\n📋 Sunday portfolio review...");
  const portfolioData = await fetchAllPrices();
  // Check for splits FIRST — must happen before pricing update
  await detectAndFixSplits(portfolioData);
  await updateAllPricingLevels(portfolioData);

  const lines = portfolioData.map(p => {
    const price         = p.price || 0;
    const stop          = getStopLoss(p.ticker, p.stopLoss);
    const target        = getTarget(p.ticker, p.target);
    const pnlPct        = p.avgCost ? (((price-p.avgCost)/p.avgCost)*100).toFixed(1) : "N/A";
    const distToStop    = stop   ? (((price-stop)/price)*100).toFixed(1)    : "N/A";
    const distToTarget  = target ? (((target-price)/price)*100).toFixed(1)  : "N/A";
    const dynamic       = state.dynamicLevels[p.ticker];
    return `${p.ticker}: $${price.toFixed(2)} (${parseFloat(pnlPct)>=0?"+":""}${pnlPct}%)\n  Stop: $${stop?.toFixed(2)||"N/A"} (${distToStop}% away)${dynamic?.stopLoss?" 📈auto":""}\n  Target: $${target?.toFixed(2)||"N/A"} (${distToTarget}% up)${dynamic?.target?" 🔄updated":""}`;
  }).join("\n\n");

  const autoStops   = Object.values(state.dynamicLevels).filter(l=>l.stopLoss).length;
  const autoTargets = Object.values(state.dynamicLevels).filter(l=>l.target).length;

  await sendSMS(`📋 SUNDAY REVIEW\n${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}\n\nAUTO-UPDATES:\n📈 Trailing stops: ${autoStops}\n🔄 Analyst targets: ${autoTargets}\n\n${lines}\n\n📈=auto stop 🔄=updated target\nNot financial advice.`);
  console.log("  ✅ Sunday summary sent.");
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════

const modeLabel = TRADIER.sandbox ? "SANDBOX" : "LIVE";

// Validate critical env vars at startup
const missingVars = [];
if (!process.env.ANTHROPIC_API_KEY)    missingVars.push("ANTHROPIC_API_KEY");
if (!process.env.PUSHOVER_USER_KEY)    missingVars.push("PUSHOVER_USER_KEY");
if (!process.env.TRADIER_ACCESS_TOKEN) missingVars.push("TRADIER_ACCESS_TOKEN");
if (!process.env.ALPHA_VANTAGE_API_KEY)missingVars.push("ALPHA_VANTAGE_API_KEY");
if (missingVars.length > 0) {
  console.error(`🚨 MISSING ENV VARS: ${missingVars.join(", ")}`);
}
const keyPreview = process.env.ANTHROPIC_API_KEY
  ? `${process.env.ANTHROPIC_API_KEY.slice(0,12)}...${process.env.ANTHROPIC_API_KEY.slice(-4)}`
  : "❌ NOT SET";
console.log(`🔑 Anthropic key: ${keyPreview}`);

console.log(`\n🚀 Options Trading Bot v2 (${modeLabel} MODE)`);
console.log(`📋 Portfolio: ${PORTFOLIO.map(p=>p.ticker).join(", ")}`);
console.log(`📊 ${PORTFOLIO.length} stocks | ${PORTFOLIO.filter(p=>p.optionable).length} optionable`);
console.log(`◎  Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day | $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | ${MANDATE.minReturnPct}%+ | Exit ${MANDATE.profitTargetPct}% profit`);
console.log(`🔗 Tradier: ${TRADIER.baseUrl}`);
console.log(`🔑 Alpha Vantage keys: ${AV_KEYS.length}`);
console.log("⏰ Schedule:");
console.log("   Mon–Fri 9:10 AM — Morning scan + execute");
console.log("   Mon–Fri 9:25 AM — Analyst targets refresh");
console.log("   Mon–Fri 9:30–4PM — Position monitor + trailing stops every 20 min");
console.log("   Mon–Fri 11AM,1PM,3PM — Opportunistic scan (5%+ moves only)");
console.log("   Mon–Fri 4:05 PM — Closing summary");
console.log("   Sunday 8:00 AM  — Full portfolio review + auto-update all levels\n");

// Schedules
cron.schedule("10 9 * * 1-5",      () => runExclusive("morningSession",       morningSession),       { timezone:"America/New_York" });
cron.schedule("25 9 * * 1-5",      () => runExclusive("updateAnalystTargets", updateAnalystTargets), { timezone:"America/New_York" });
cron.schedule("*/20 9-16 * * 1-5", () => runExclusive("intradayCheck",        intradayCheck),        { timezone:"America/New_York" });

// Opportunistic mid-day scan: 11 AM, 1 PM, 3 PM ET Mon-Fri — NOTE this
// collides on-the-minute with intradayCheck's */20 schedule at 11:00,
// 13:00, 15:00. runExclusive() ensures only one of them actually runs
// when that happens; the other is safely skipped and logged.
cron.schedule("0 11,13,15 * * 1-5", () => runExclusive("opportunisticScan",    opportunisticScan),    { timezone:"America/New_York" });
cron.schedule("5 16 * * 1-5",      () => runExclusive("closingSession",       closingSession),       { timezone:"America/New_York" });
cron.schedule("0 8 * * 0",         () => runExclusive("sundaySummary",        sundaySummary),        { timezone:"America/New_York" });

// Startup
await sendSMS(`◈ OPTIONS BOT v2 ACTIVE (${modeLabel})
Portfolio: ${PORTFOLIO.filter(p=>p.optionable).map(p=>p.ticker).join(", ")}
${PORTFOLIO.length} stocks | ${PORTFOLIO.filter(p=>p.ivProfile==="high").length} high-IV names
Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day | $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | ${MANDATE.minReturnPct}%+ return
Auto-execute: ENABLED | Broker: Tradier ${modeLabel}
Trailing stops: ENABLED | Analyst targets: AUTO-UPDATE

Schedule: 9:10AM execute | 9:25 targets | 20min monitor | 4PM close | Sun 8AM review`);

// ================================================================
// ═══════════════════════════════════════════════════════════════
// ORPHANED POSITION RECONCILIATION
// state.openPositions lives in memory only — every Railway redeploy
// resets it to []. Any Tradier position opened before a restart
// becomes permanently invisible to monitorOpenPositions (profit
// target, stop-loss, breached-strike, DTE checks all key off
// state.openPositions, so an orphan gets NONE of them). This runs
// once at boot: fetch real Tradier positions, compare against the
// (freshly emptied) in-memory state, and loudly alert on anything
// found that the bot has no record of — rather than silently
// managing zero risk on a real, live position.
// ═══════════════════════════════════════════════════════════════

async function reconcileOrphanedPositions() {
  console.log("\n🔍 Checking for orphaned Tradier positions (untracked after restart)...");
  try {
    const positions = await getTradierPositions();
    if (!positions.length) {
      console.log("  ✓ No open Tradier positions — nothing to reconcile.");
      return;
    }

    // Group by underlying symbol for a readable alert
    const bySymbol = {};
    for (const pos of positions) {
      const underlying = pos.symbol.match(/^[A-Z]+/)?.[0] || pos.symbol;
      if (!bySymbol[underlying]) bySymbol[underlying] = [];
      bySymbol[underlying].push(pos);
    }

    const orphanSummaries = [];
    for (const [underlying, legs] of Object.entries(bySymbol)) {
      const tracked = legs.every(pos => state.openPositions.some(t => t.legs?.some(l => l.symbol === pos.symbol)));
      if (!tracked) {
        orphanSummaries.push(`${underlying}: ${legs.length} leg(s) — NOT tracked, no automated exit rules will apply`);
      }
    }

    if (orphanSummaries.length > 0) {
      console.error(`  🚨 ${orphanSummaries.length} orphaned position group(s) found — bot restarted and lost tracking:`);
      orphanSummaries.forEach(s => console.error(`     ${s}`));
      await sendSMS(
`🚨 ORPHANED POSITIONS DETECTED
Bot restarted — in-memory tracking was reset.

${orphanSummaries.join("\n")}

These positions are REAL and OPEN in Tradier but have NO automated stop-loss, profit-target, or breach protection until manually reviewed.
Check Tradier sandbox directly and close or manage manually.`
      );
    } else {
      console.log(`  ✓ All ${positions.length} live Tradier position(s) are properly tracked.`);
    }
  } catch(e) {
    console.error(`  ✗ Reconciliation check failed: ${e.message}`);
  }
}

// SECURE BOOT — wraps startup check so cron schedules survive
// any transient network error on boot
// ================================================================
(async () => {
  try {
    console.log("  ⏳ Running startup diagnostics...");
    await reconcileOrphanedPositions();
    await runExclusive("startupDiagnostics", intradayCheck);
    console.log("  🚀 Diagnostics clear. Background crons running.");


  } catch (bootError) {
    console.error("  🛑 BOOT ERROR:", bootError.message);
    await sendSMS(
      `⚠️ OPTIONS BOT BOOT ERROR\n${bootError.message}\nSchedules registered but startup check failed. Crons still running.`
    );
  }
})();

// ================================================================
// CONTINUOUS KEEP-ALIVE HEARTBEAT
// Forces the Node.js event loop to stay active indefinitely so cloud
// platforms (like Railway) do not shut down the background crons.
// ================================================================
console.log("⏰ Continuous Keep-Alive Heartbeat engaged. Event loop locked open.");
setInterval(() => {
  const hr = new Date().getHours();
  // Keep the logs quiet overnight, print a pulse check during market hours
  if (hr >= 9 && hr <= 17) {
    console.log(`[${new Date().toLocaleTimeString()}] 💓 System pulse check: Event loop active.`);
  }
}, 10 * 60 * 1000); // Fires a quiet ping every 10 minutes
