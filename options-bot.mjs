// ================================================================
// OPTIONS TRADING BOT v2 — FULLY AUTOMATED WITH TRADIER + PUSHOVER
// ================================================================
// Portfolio : 17 stocks — NVDA AMD AVGO MSFT AAPL AMZN GOOGL META
//             TSLA PANW CRWD SPY QQQ OKLO LLY PLTR NOW
// Removed   : SPOK (illiquid), CMBT (no options), XLE (replaced by SPY/QQQ)
// Added     : AMZN GOOGL META AVGO PANW CRWD SPY QQQ
// Mandate   : $1,000–$5,000/day · $400–$1,200/trade · 8%+ return
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
//   PUSHOVER_USER_KEY=<your pushover user key>
//   PUSHOVER_API_TOKEN=<your pushover app token>
// (Alpha Vantage keys no longer needed — all prices via Tradier as of Jul 29 2026)
//   TRADIER_ACCESS_TOKEN=<your tradier token>
//   TRADIER_ACCOUNT_ID=<your account id>
//   TRADIER_SANDBOX=true                (set false for live trading)
// ================================================================

import Anthropic from "@anthropic-ai/sdk";
import cron      from "node-cron";
import fs        from "fs";
// fetch is native in Node 18+ — no import needed
import dotenv    from "dotenv";
dotenv.config();

// ── CRITICAL STARTUP GUARD ────────────────────────────────────
// Exit immediately if required keys are missing — prevents silent
// failures where the bot starts, logs nothing useful, then silently
// fails every API call for the rest of the session.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("🛑 CRITICAL: ANTHROPIC_API_KEY is not set in environment variables.");
  console.error("   Add it to Railway Variables tab and redeploy.");
  process.exit(1);
}
if (!process.env.TRADIER_ACCESS_TOKEN) {
  console.error("🛑 CRITICAL: TRADIER_ACCESS_TOKEN is not set. Every order and price fetch will fail.");
  console.error("   Add it to Railway Variables tab and redeploy.");
  process.exit(1);
}
if (!process.env.TRADIER_ACCOUNT_ID) {
  console.error("🛑 CRITICAL: TRADIER_ACCOUNT_ID is not set. Cannot target the correct account.");
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
  dailyCapMax:     5000,
  maxPerTrade:     1200,
  minPerTrade:     400,
  minReturnPct:    8,
  profitTargetPct: 50,   // close at 50% of max profit
  stopLossPct:     50,   // DEBIT strategies (spreads): close at 50% loss — data shows positions
                         // going to near-zero before 100% fires (AMZN -95.7% Aug 4 2026).
                         // A spread down 50% with 4 DTE rarely recovers; better to close and
                         // redeploy capital than watch it expire worthless.
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
// Derived from PORTFOLIO.earningsDate — single source of truth.
// Previously a separate hardcoded map that could silently drift from PORTFOLIO.
const EARNINGS = Object.fromEntries(
  PORTFOLIO.filter(p => p.earningsDate).map(p => [p.ticker, p.earningsDate])
);

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
// PERSISTENT STATE — survives Railway redeploys
// state.openPositions previously lived in memory ONLY, meaning every
// redeploy silently orphaned any open trade (see this week's AVGO,
// NVDA, QQQ, PANW, SPY incidents — thousands of dollars in
// unmonitored losses, all traced back to this single gap).
//
// REQUIRES a Railway Volume mounted at the path below. Without one,
// this degrades gracefully to the old in-memory-only behavior (with
// a loud warning), since a plain container filesystem is wiped on
// every redeploy exactly like memory was.
// ═══════════════════════════════════════════════════════════════

const STATE_FILE = process.env.STATE_FILE_PATH || "/data/bot-state.json";

function saveState() {
  try {
    const persistable = {
      openPositions:      state.openPositions,
      dailyTrades:        state.dailyTrades,
      totalDeployedToday: state.totalDeployedToday,
      dailyPnL:           state.dailyPnL,
      dynamicLevels:      state.dynamicLevels,
      weeklyHighs:        state.weeklyHighs,
      alertsSent:         [...state.alertsSent], // Set → Array for JSON serialisation
      savedAt:            new Date().toISOString(),
    };
    // Write to temp file then atomically rename — prevents a partial
    // write (crash mid-write, disk full) from corrupting the live state.
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(persistable, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch(e) {
    console.error(`  ✗ Failed to save state to ${STATE_FILE}: ${e.message}`);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log(`  ℹ No persisted state file at ${STATE_FILE} — starting fresh (expected on first-ever boot or if no Volume is mounted)`);
      return false;
    }
    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));

    state.openPositions = persisted.openPositions || [];
    state.dynamicLevels = persisted.dynamicLevels || {};
    state.weeklyHighs   = persisted.weeklyHighs   || {};
    // Restore dedup keys so a mid-day restart doesn't re-fire alerts
    // that already fired this hour. alertsSent was serialised as Array.
    if (Array.isArray(persisted.alertsSent)) {
      state.alertsSent = new Set(persisted.alertsSent);
    }

    // Daily counters (trades placed today, capital deployed today) only
    // make sense if the saved state is from TODAY — a redeploy that
    // happens to land on a new trading day should start those at zero
    // naturally, not carry yesterday's totals forward.
    const savedDate = persisted.savedAt ? new Date(persisted.savedAt).toDateString() : null;
    const today      = new Date().toDateString();
    if (savedDate === today) {
      state.dailyTrades        = persisted.dailyTrades || [];
      state.totalDeployedToday = persisted.totalDeployedToday || 0;
      state.dailyPnL           = persisted.dailyPnL || 0;
    }

    console.log(`  ✓ Restored state from disk: ${state.openPositions.length} open position(s) — saved ${persisted.savedAt}`);
    return true;
  } catch(e) {
    console.error(`  ✗ Failed to load persisted state: ${e.message}`);
    return false;
  }
}

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
  user:  process.env.PUSHOVER_USER_KEY,
  token: process.env.PUSHOVER_API_TOKEN,
};
if (!PUSHOVER.user || !PUSHOVER.token) {
  console.error("⚠️  WARNING: PUSHOVER_USER_KEY or PUSHOVER_API_TOKEN not set — push notifications will fail.");
}

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

async function tradierRequest(method, path, params = {}, attempt = 1) {
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

  // Explicit rate-limit handling. Confirmed via Tradier's own docs:
  // /markets endpoints are capped at 60 req/min (sandbox) / 120 req/min
  // (production) — a per-minute window, not a daily one. Batched
  // multi-symbol requests (as fetchAllPrices now uses) count as ONE
  // request regardless of symbol count, so normal usage sits well under
  // this. Still worth handling explicitly: with the trade-count cap
  // removed, a busy morning session can fire more Tradier calls than
  // before, and a 429 mid-session would otherwise look identical to a
  // normal rejection in the log.
  //
  // NOTE: Tradier's docs mention custom response headers for gauging
  // rate-limit usage but don't confirm the exact header name for
  // "seconds until reset" — checking the standard Retry-After header
  // is a harmless best-effort first attempt (used if present), and the
  // exponential fallback below is the real safety net either way, so
  // this retries correctly regardless of which header Tradier sends.
  if (res.status === 429) {
    if (attempt >= 3) {
      throw new Error(`Tradier ${method} ${path} (429): rate limited after ${attempt} attempts, giving up`);
    }
    const retryAfterHeader = res.headers.get("Retry-After");
    const wait = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : attempt * 2000;
    console.log(`  ⚠ Tradier rate limited (429) on ${path} — retrying in ${wait/1000}s (attempt ${attempt}/3)`);
    await new Promise(r => setTimeout(r, wait));
    return tradierRequest(method, path, params, attempt + 1);
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
    if (!p) return []; // confirmed by Tradier: genuinely zero positions
    return Array.isArray(p) ? p : [p];
  } catch(e) {
    console.error(`  ✗ Positions: ${e.message}`);
    // CRITICAL DISTINCTION: null means "fetch failed, unknown state" —
    // NEVER treat this the same as a confirmed-empty [] response. A
    // transient network/API failure must not be interpreted as proof
    // the account is flat — any caller that mutates state.openPositions
    // based on "no positions found" MUST check for null first and skip
    // any destructive action, only proceeding on a genuine [] (or a
    // real array of positions).
    return null;
  }
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
    const status  = data?.order?.status;

    // Tradier returns an orderId even for REJECTED orders — previously we
    // checked only for orderId presence and declared success, causing the
    // bot to remove positions from tracking after rejected closes.
    // Confirmed Aug 7 2026: SPY and AMZN close orders rejected 4 times each;
    // bot removed them from state.openPositions → inline restore fired every
    // cycle. Fix: verify status === "ok" before declaring success.
    if (!orderId) {
      console.error(`  ✗ No order ID returned from Tradier`);
      return { success:false, error:"No order ID returned" };
    }
    if (status && status !== "ok") {
      console.error(`  ✗ Order ${orderId} rejected by Tradier (status: ${status})`);
      return { success:false, error:`Order rejected: ${status}`, orderId };
    }

    console.log(`  ✅ Order placed: ${orderId}`);
    return { success:true, orderId };
  } catch(e) {
    console.error(`  ✗ Order failed: ${e.message}`);
    return { success:false, error:e.message };
  }
}

async function closeOptionsPosition(position) {
  const closeSide = position.side === "buy_to_open" ? "sell_to_close" : "buy_to_close";
  const orderParams = {
    class:"option", symbol:position.underlyingSymbol || position.ticker,
    option_symbol:position.symbol, side:closeSide,
    quantity:Math.abs(position.quantity), type:"market", duration:"day",
  };

  // Retry up to 3 times with backoff — Tradier sandbox occasionally rejects
  // close orders on first submission due to transient liquidity/matching issues,
  // then accepts on retry. Confirmed Aug 7 2026: SPY $712P and AMZN spread
  // each rejected 3-4 times before eventually filling. Without retries the bot
  // was removing positions from tracking after the first rejection and then
  // inline-restoring them every 20-min cycle indefinitely.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data    = await tradierRequest("POST", `/accounts/${TRADIER.accountId}/orders`, orderParams);
      const orderId = data?.order?.id;
      const status  = data?.order?.status;

      if (!orderId) {
        console.error(`  ✗ Close attempt ${attempt}: no order ID returned`);
      } else if (status && status !== "ok") {
        console.error(`  ✗ Close attempt ${attempt}: order ${orderId} rejected (status: ${status})`);
      } else {
        // Success
        return { success:true, orderId };
      }
    } catch(e) {
      console.error(`  ✗ Close attempt ${attempt}: ${e.message}`);
    }

    if (attempt < 3) {
      const wait = attempt * 5000; // 5s, 10s
      console.log(`  ⏳ Retrying close in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  return { success:false, error:"Close order rejected after 3 attempts" };
}

async function buildOptionsLegs(tradeRec, stockPrice, regime = null) {
  const { ticker, strategy } = tradeRec;
  try {
    const expirations = await getExpirations(ticker);
    // Use UTC date strings for DTE — new Date("2026-08-10") parses as UTC midnight,
    // so subtracting a local new Date() gives off-by-one errors on non-UTC servers.
    // Consistent with the same fix applied in monitorOpenPositions.
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayUTC = new Date(todayStr + "T00:00:00Z");
    const validExp    = expirations.find(exp => {
      const dte = Math.ceil((new Date(exp + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
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

        // MOMENTUM ENTRY RULE (Aug 4 2026): reject bull spreads where the stock
        // is trading significantly below its weekly high. A stock that needs to
        // rally >3% to reach the long strike is a low-probability setup — we've
        // already confirmed this kills these trades (AMZN -95.7% the same day
        // MSFT +39.1%; the difference was MSFT was at ATH, AMZN was 3% below).
        const weekHigh = state.weeklyHighs[ticker];
        if (weekHigh && stockPrice < weekHigh * 0.97) {
          console.log(`  ✗ ${ticker} Bull Call Spread REJECTED — price $${stockPrice} is ${(((stockPrice-weekHigh)/weekHigh)*100).toFixed(1)}% below week high $${weekHigh}. Need momentum to enter directional spread.`);
          return null;
        }

        const cost = (lc.ask - sc.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        const midpoint = parseFloat(((lc.ask - sc.bid) / 2 + (lc.bid - sc.ask) / 2).toFixed(2));
        return { expiration:validExp, legs:[{symbol:lc.symbol,side:"buy_to_open"},{symbol:sc.symbol,side:"sell_to_open"}], cost:Math.round(cost), maxProfit:Math.round((sc.strike-lc.strike-(lc.ask-sc.bid))*100), longSymbol:lc.symbol, shortSymbol:sc.symbol, limitPrice:midpoint, quantity:1 };
      }
      case "Bear Put Spread": {
        const bearOtm = (regime?.otmPct ?? 3) / 100;
        const lp = puts.find(p => p.strike <= stockPrice * 1.01);
        const sp = puts.find(p => p.strike <= stockPrice * (1 - bearOtm));
        if (!lp || !sp) return null;

        // MOMENTUM ENTRY RULE (symmetric with Bull Call Spread): reject bear spreads
        // where the stock has rallied far above its weekly low. A stock at weekly
        // highs needs a large reversal just to move toward the put strikes — low
        // probability unless there's clear breakdown momentum today.
        // "Weekly low" approximated as the inverse of weeklyHighs: if the stock is
        // within 3% of its weekly high, it's NOT in breakdown territory.
        const weekHigh = state.weeklyHighs[ticker];
        if (weekHigh && stockPrice > weekHigh * 0.97) {
          console.log(`  ✗ ${ticker} Bear Put Spread REJECTED — price $${stockPrice} is within 3% of week high $${weekHigh}. Need downside momentum for bearish spread.`);
          return null;
        }

        const cost = (lp.ask - sp.bid) * 100;
        if (cost < MANDATE.minPerTrade || cost > MANDATE.maxPerTrade) return null;
        return { expiration:validExp, legs:[{symbol:lp.symbol,side:"buy_to_open"},{symbol:sp.symbol,side:"sell_to_open"}], cost:Math.round(cost), maxProfit:Math.round((lp.strike-sp.strike-(lp.ask-sp.bid))*100), quantity:1 };
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
        // Scale quantity so total credit lands inside the $400-$1200 mandate
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
        // collateral) lands inside the mandate's $400-$1200 range.
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
// PRICE FEEDS — all prices via Tradier (batched single call).
// Alpha Vantage fully retired Jul 29 2026 — see comment below.
// ═══════════════════════════════════════════════════════════════

// Alpha Vantage fully retired Jul 29 2026. Stock prices moved to Tradier
// (fixed the recurring daily-quota exhaustion). VIX/SPY sentiment moved
// to getSpyChangeFromPortfolio() (fixed the ^VIX symbol never having
// been a valid GLOBAL_QUOTE target in the first place — see the block
// comment above that function for the full story). No API keys needed.
//
// fetchStockPrice (per-ticker with cache) was removed Aug 2026 after
// monitorOpenPositions was refactored to receive a fresh priceMap from
// intradayCheck, making the per-ticker cache entirely unreachable.

async function fetchAllPrices() {
  console.log(`  Fetching ${PORTFOLIO.length} prices (Tradier, batched)...`);
  try {
    const tickers = PORTFOLIO.map(s => s.ticker);
    const quotes  = await getOptionQuote(tickers); // single batched call, no per-symbol rate limit
    const now     = Date.now();
    const results = [];

    for (const stock of PORTFOLIO) {
      const q = quotes.find(x => x.symbol === stock.ticker);
      if (!q || q.last == null) continue;
      const data = {
        ticker:    stock.ticker,
        price:     parseFloat(q.last),
        change:    parseFloat(q.change ?? 0),
        changePct: parseFloat(q.change_percentage ?? 0),
        volume:    parseInt(q.volume ?? 0),
        high:      parseFloat(q.high ?? q.last),
        low:       parseFloat(q.low ?? q.last),
      };
      state.priceCache[stock.ticker] = { ts: now, data };
      results.push({ ...stock, ...data });
    }
    console.log(`  ✓ Prices: ${results.length}/${PORTFOLIO.length}`);
    return results;
  } catch(e) {
    console.error(`  ✗ Batched price fetch failed: ${e.message} — falling back to cache`);
    return PORTFOLIO.map(s => ({ ...s, ...(state.priceCache[s.ticker]?.data || {}) })).filter(s => s.price);
  }
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
// MARKET SENTIMENT — SPY day change used as regime signal
// Used by generateTrades to adjust strategy selection and
// condor wing width based on current market conditions.
// (Alpha Vantage VIX/SPY fetching retired Jul 29 2026 — see
//  getMarketRegime for full history of why VIX was dropped)
// ═══════════════════════════════════════════════════════════════

// VIX_REGIME removed — regime thresholds now hardcoded directly
// in getMarketRegime() based on SPY change alone (see that function).

// ═══════════════════════════════════════════════════════════════
// REGIME SIGNAL — retired Alpha Vantage VIX/SPY fetching entirely
// (Jul 29 2026). Root cause of "VIX fetch failed... defaulting to 18"
// appearing in EVERY session log: GLOBAL_QUOTE doesn't support index
// symbols like ^VIX at all — that call could never have succeeded.
// SPY's fetch failed too, via a different mechanism (the reserved
// Alpha Vantage key was independently exhausted). CONSEQUENCE: since
// a defaulted VIX of 18 can never exceed any threshold (18 IS the
// calm boundary) and a defaulted SPY change of 0 can never be below
// any negative threshold, getMarketRegime(18, 0) always evaluated to
// NORMAL — every single session since this system was built never
// once actually classified real market conditions.
//
// FIX: derive the regime signal from SPY's day change already
// present in portfolioData (fetched reliably via Tradier's batched
// quote call every cycle) — no separate network call, no external
// dependency, no possibility of a silent default masking a real
// failure. VIX itself is dropped; SPY's move is a well-established,
// highly-correlated proxy for broad market volatility.
// ═══════════════════════════════════════════════════════════════

function getSpyChangeFromPortfolio(portfolioData) {
  const spy = portfolioData.find(p => p.ticker === "SPY");
  if (!spy || spy.changePct == null) {
    console.log(`  ⚠ SPY not found in portfolio data — defaulting regime signal to 0%`);
    return 0;
  }
  return spy.changePct;
}

function getMarketRegime(spyChangePct) {
  // Regime classification driven purely by SPY's day change — see the
  // block comment above getSpyChangeFromPortfolio for why VIX was
  // dropped entirely rather than left as a (previously always-broken)
  // secondary input. Same threshold values that were already tested
  // and tuned this week (the -0.3% ELEVATED threshold specifically
  // calibrated against the July 14 borderline-volatility session) —
  // only the broken input source changed, not the trigger points.
  if (spyChangePct < -3.0) {
    return {
      label:            "EXTREME FEAR",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         false,
      skipTrading:      true,
      wingMultiplier:   2.0,
      otmPct:           5,    // widest wings if somehow a trade slips through
      note:             `SPY ${spyChangePct.toFixed(1)}% — no new trades today. Extreme fear.`,
    };
  }
  // STRONG RALLY (SPY > +1%): Iron Condors are equally dangerous on the upside
  // as the downside — the short CALL legs get breached just as readily as short
  // PUT legs in a falling market. Confirmed Aug 4 2026: SPY rallied from $757 to
  // $772 (+2%) and all three Iron Condors placed that morning had short calls
  // breached within hours. Block condors symmetrically on large moves either direction.
  if (spyChangePct > 1.0) {
    return {
      label:            "STRONG RALLY",
      allowDirectional: true,   // bull spreads remain valid — market has momentum
      allowCondors:     false,  // short calls at risk in sustained uptrend
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.0,
      otmPct:           3,
      note:             `SPY +${spyChangePct.toFixed(1)}% — condors blocked (short calls at risk), directional OK`,
    };
  }
  if (spyChangePct < -1.0) {
    return {
      label:            "HIGH VOLATILITY",
      allowDirectional: false,
      allowCondors:     false,  // short puts at risk in falling market
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.5,
      otmPct:           5,
      note:             `SPY ${spyChangePct.toFixed(1)}% — condors blocked (short puts at risk), CSP only`,
    };
  }
  if (spyChangePct < -0.3) {
    return {
      label:            "ELEVATED VOLATILITY",
      allowDirectional: false,
      allowCondors:     true,
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.25,
      otmPct:           4,
      note:             `SPY ${spyChangePct.toFixed(1)}% — income only, wider 4% OTM wings`,
    };
  }
  return {
    label:            "NORMAL",
    allowDirectional: true,
    allowCondors:     true,
    allowCSP:         true,
    skipTrading:      false,
    wingMultiplier:   1.0,
    otmPct:           3,
    note:             `SPY ${spyChangePct.toFixed(1)}% — all strategies allowed, 3% OTM`,
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

      // 401 (auth) and 400 (bad request) are NOT retried —
      // they are permanent failures; retrying only adds latency.
      const isRetryable = e.message.includes("Connection error") ||
                          e.message.includes("ECONNREFUSED") ||
                          e.message.includes("ENOTFOUND") ||
                          e.message.includes("fetch failed") ||
                          e.message.includes("network") ||
                          e.message.includes("timeout") ||
                          e.status === 529 ||
                          e.status === 503;
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

// ── PROMPT BUILDER ────────────────────────────────────────────
// Extracted from generateTrades so the prompt logic is independently
// readable and testable without touching the AI call or filtering.
function buildTradePrompt({ today, optionable, regime, spyChange, sectorHealth,
                            weakSectors, earningsWarnings, allowedStrategies }) {
  const priceLines = optionable.map(p => {
    const health      = sectorHealth[p.ticker];
    const warn        = (!health?.healthy) ? " ⚠️ SECTOR WEAK" : "";
    const weekHigh    = state.weeklyHighs[p.ticker];
    const pctFromHigh = weekHigh ? (((p.price - weekHigh) / weekHigh) * 100).toFixed(1) : null;
    const momentumNote = pctFromHigh !== null
      ? (parseFloat(pctFromHigh) >= 0 ? ` | AT/NEAR WEEK HIGH (+${pctFromHigh}%)` : ` | ${pctFromHigh}% from week high`)
      : "";
    return `${p.ticker}: $${p.price?.toFixed(2)} ${(p.changePct||0)>=0?"▲":"▼"}${Math.abs(p.changePct||0).toFixed(2)}% | IV:${p.ivProfile} | ${p.sector}${momentumNote}${warn}`;
  }).join("\n");

  return `You are a professional options trader. Generate as many high-quality options trades as fit within today's remaining capital — there is no fixed trade count, only the dollar budget and mandate criteria below. Do not pad the count with marginal setups just to use the budget; only include trades that genuinely meet the return and quality bar.

DATE: ${today}
MANDATE: $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax} daily | ${MANDATE.minReturnPct}%+ return | Exit at ${MANDATE.profitTargetPct}% profit | Max ${MANDATE.maxDTE} DTE

MARKET REGIME: ${regime.label}
SPY Day Change: ${spyChange.toFixed(2)}%
REGIME NOTE: ${regime.note}
WING WIDTH MULTIPLIER: ${regime.wingMultiplier}x (apply to all condor strikes — wider wings in high volatility)

⚠️ ALLOWED STRATEGIES TODAY: ${allowedStrategies.join(", ")}
${!regime.allowDirectional ? "🚫 DO NOT suggest Bull Call Spreads or Bear Put Spreads today — market conditions require income-only strategies" : ""}

LIVE PRICES (${optionable.length} stocks):
${priceLines}

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

⚠️ MOMENTUM ENTRY RULE (data-driven from Aug 4 2026 AMZN loss):
For Bull Call Spreads: ONLY suggest if the stock is trading AT or ABOVE its weekly high, or clearly in an uptrend today (up 1%+).
A stock below its weekly high needs a large rally just to reach the long strike — low probability setup.
For Bear Put Spreads: ONLY suggest if the stock is at/near weekly LOW or clearly breaking down today (down 1%+).
Stocks marked "AT/NEAR WEEK HIGH" are ideal for Bull Call Spreads. Stocks far below their week high are NOT.
Iron Condors: prefer stocks that have been rangebound this week (not near highs OR lows).

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
}

// ── TRADE NORMALISER + FILTER ──────────────────────────────────
// Extracted from generateTrades so normalisation/filter logic is
// independently testable without needing an AI call.
function normaliseAndFilterTrades(parsed) {
  const isDirectional = s => ["Bull Call Spread", "Bear Put Spread"].includes(s);

  const normalised = parsed.map(t => ({
    ...t,
    targetCost:      t.targetCost      ?? t.cost        ?? t.tradeCost   ?? 0,
    targetReturnPct: t.targetReturnPct ?? t.returnPct   ?? t.return      ?? "0",
    setupScore:      t.setupScore      ?? t.score       ?? t.quality     ?? 0,
    strategy:        t.strategy        ?? t.type        ?? t.tradeType   ?? "Unknown",
    direction:       t.direction       ?? t.bias        ?? "NEUTRAL",
    rationale:       t.rationale       ?? t.reason      ?? t.explanation ?? "",
    exitTarget:      t.exitTarget      ?? t.exitRule    ?? t.exit        ?? "",
  }));

  const passed = normalised.filter(t => {
    if (t.targetCost < MANDATE.minPerTrade || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) return false;
    if (isDirectional(t.strategy) && HIGH_BETA_TICKERS.includes(t.ticker)) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — high-beta ticker, income-only`);
      return false;
    }
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

async function generateTrades(portfolioData, preComputedRegime = null) {
  const optionable = portfolioData.filter(p => p.optionable && p.price);
  const today      = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  let spyChange, regime;
  if (preComputedRegime) {
    ({ spyChange, regime } = preComputedRegime);
    console.log(`  📊 Using pre-computed regime: ${regime.label} (passed from caller)`);
  } else {
    spyChange = getSpyChangeFromPortfolio(portfolioData);
    regime    = getMarketRegime(spyChange);
    console.log(`  📊 Market regime: ${regime.label} — ${regime.note}`);
  }

  if (regime.skipTrading) {
    await sendSMS(`⚠️ OPTIONS BOT\nNo trades today — ${regime.note}\nBot resumes tomorrow.`);
    return [];
  }

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

  const todayUTCms = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const earningsWarnings = Object.entries(EARNINGS)
    .map(([t,d]) => ({ t, d, days: Math.ceil((new Date(d + "T00:00:00Z") - todayUTCms) / (1000*60*60*24)) }))
    .filter(e => e.days > 0 && e.days <= 14)
    .map(e => `${e.t} in ${e.days} days`);

  const allowedStrategies = [];
  if (regime.allowCSP)         allowedStrategies.push("Cash Secured Put");
  if (regime.allowCondors)     allowedStrategies.push("Iron Condor");
  if (regime.allowDirectional) allowedStrategies.push("Bull Call Spread", "Bear Put Spread");

  const prompt = buildTradePrompt({
    today, optionable, regime, spyChange, sectorHealth,
    weakSectors, earningsWarnings, allowedStrategies,
  });

  // max_tokens raised from 1000 -> 3000: with the trade-count cap removed,
  // a rich-premium day can legitimately produce 8-12+ trades at the new
  // $400 floor. Each trade object is ~80-100 tokens; 1000 tokens was only
  // safe for ~8-10 before silent JSON truncation.
  const msg = await retryAI(() => ai.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 3000,
    messages:   [{ role: "user", content: prompt }],
  }));

  const allText = msg.content
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("")
    .trim();

  if (!allText) throw new Error("No text block in generateTrades response");

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

  return normaliseAndFilterTrades(parsed);
}

// ═══════════════════════════════════════════════════════════════
// ALERT DETECTION
// ═══════════════════════════════════════════════════════════════

// stock is a merged object from fetchAllPrices: { ...portfolioConfig, ...liveQuote }
// contains both config fields (ticker, stopLoss, target) and live price fields
// (price, changePct). Previously took (stock, priceData) with the same object
// passed twice — simplified to one arg since they were always identical.
function detectAlerts(stock) {
  const alerts         = [];
  const price          = stock.price;
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
  const absPct = Math.abs(stock.changePct || 0);
  if (absPct >= 6) {
    alerts.push({ type:"BIG_MOVE", urgency:`${stock.changePct>0?"🚀":"📉"} ${absPct.toFixed(1)}%`, msg:`Large move — IV likely elevated, options opportunity.` });
  }
  const earningsDate = EARNINGS[stock.ticker];
  if (earningsDate) {
    // UTC comparison — new Date(earningsDate) parses as UTC midnight;
    // subtracting a local new Date() gives off-by-one on non-UTC servers.
    // Same fix applied in generateTrades (line ~1056) and buildOptionsLegs.
    const todayMs = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
    const days    = Math.ceil((new Date(earningsDate + "T00:00:00Z") - todayMs) / (1000*60*60*24));
    if ([7,3,1].includes(days)) {
      alerts.push({ type:"EARNINGS", urgency:"📅 EARNINGS", msg:`Reports in ${days} day${days===1?"":"s"} (${earningsDate}). Close or roll options before then.` });
    }
  }
  return alerts;
}

// ── SHARED P&L HELPER ─────────────────────────────────────────
// Single source of truth — previously copy-pasted in both
// monitorOpenPositions and getLivePositionSnapshot.
function computePnL(ourTrade, g) {
  const openCost        = ourTrade.executedCost / g.qty / 100;
  const maxProfitShare  = (ourTrade.maxProfit || ourTrade.executedCost) / g.qty / 100;
  const currentPnL      = ourTrade.isCredit
    ? (openCost - g.currentValue) * g.qty * 100
    : (g.currentValue - openCost) * g.qty * 100;
  const currentPct      = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;
  const profitTargetPnL = maxProfitShare * g.qty * 100 * (MANDATE.profitTargetPct / 100);
  return { openCost, maxProfitShare, currentPnL, currentPct, profitTargetPnL };
}

// ── TRADE RECONSTRUCTION FROM TRADIER POSITIONS ───────────────
// When a position is orphaned (in Tradier but not in state.openPositions),
// rebuilds a minimal tracking record so monitoring can resume.
function rebuildTradeFromPositions(underlying, legs) {
  try {
    const symMatch = legs[0]?.symbol?.match(/[A-Z]+(\d{2})(\d{2})(\d{2})[CP]/);
    if (!symMatch) return null;
    const expiration = `20${symMatch[1]}-${symMatch[2]}-${symMatch[3]}`;

    const qty     = Math.max(...legs.map(p => Math.abs(p.quantity)));
    const hasCall = legs.some(p => /[A-Z]+\d+C\d/.test(p.symbol));
    const hasPut  = legs.some(p => /[A-Z]+\d+P\d/.test(p.symbol));

    let strategy;
    if (hasCall && hasPut && legs.length >= 4) strategy = "Iron Condor";
    else if (hasCall && legs.length >= 2)      strategy = "Bull Call Spread";
    else if (hasPut  && legs.length >= 2)      strategy = "Bear Put Spread";
    else if (hasPut  && legs.length === 1)     strategy = "Cash Secured Put";
    else return null;

    const reconstructedLegs = legs.map(p => ({
      symbol: p.symbol,
      side:   p.quantity > 0 ? "buy_to_open" : "sell_to_open",
    }));

    let shortCallStrike, shortPutStrike;
    if (strategy === "Iron Condor") {
      const sc = legs.filter(p => /[A-Z]+\d+C\d/.test(p.symbol) && p.quantity < 0);
      const sp = legs.filter(p => /[A-Z]+\d+P\d/.test(p.symbol) && p.quantity < 0);
      if (sc.length) { const m = sc[0].symbol.match(/C(\d{8})/); shortCallStrike = m ? parseInt(m[1])/1000 : undefined; }
      if (sp.length) { const m = sp[0].symbol.match(/P(\d{8})/); shortPutStrike  = m ? parseInt(m[1])/1000 : undefined; }
    }

    // Tradier cost_basis is negative for short (sold) legs — summing gives net credit.
    const netCostBasis = legs.reduce((sum, p) => sum + (p.cost_basis || 0), 0);
    const isCredit     = netCostBasis < 0;
    const executedCost = Math.abs(Math.round(netCostBasis));

    // Use Tradier's date_acquired so the grace period ages correctly.
    // Fallback to 2h ago to ensure the trade is past the grace window.
    const dateAcquired = legs[0]?.date_acquired
      ? new Date(legs[0].date_acquired).toISOString()
      : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    return {
      ticker: underlying, strategy, legs: reconstructedLegs,
      quantity: qty, expiration,
      executedAt: dateAcquired, executedCost,
      maxProfit: isCredit ? executedCost : 0, isCredit,
      shortCallStrike, shortPutStrike,
      status: "OPEN", reconstructed: true,
    };
  } catch (e) {
    console.error(`  ✗ rebuildTradeFromPositions(${underlying}): ${e.message}`);
    return null;
  }
}

async function getGroupedLivePositions() {
  const positions = await getTradierPositions();

  // CRITICAL: positions can now be null (fetch failed) or [] (confirmed
  // empty) — these must NEVER be treated the same. null means "unknown
  // state, do nothing." Only a genuine [] (or non-empty array) is safe
  // to act on. This distinction exists specifically because an earlier
  // version of this function conflated the two, which would have wiped
  // state.openPositions on nothing more than a transient network blip.
  if (positions === null) {
    console.log(`  ⚠ Tradier positions fetch failed — skipping this cycle, state.openPositions left untouched.`);
    return [];
  }

  if (!positions.length) {
    // Confirmed by Tradier: the account genuinely has zero positions.
    // Safe to clean up any tracked trades, since this is verified data,
    // not a fetch failure masquerading as an empty result.
    if (state.openPositions.length > 0) {
      const staleList = state.openPositions.map(t => `${t.ticker} ${t.strategy}`).join(", ");
      console.error(`  🧹 STALE TRACKED POSITIONS: Tradier confirms account is flat but ${state.openPositions.length} trade(s) still tracked — removing: ${staleList}`);
      state.openPositions = [];
      await sendSMS(
`🧹 STALE POSITION CLEANUP
${staleList}

Tradier confirms the account is fully flat but these were still tracked as open — likely closed successfully despite an earlier reported close failure.

Removed from tracking. Verify final P&L manually if needed.
Not financial advice.`
      );
      saveState();
    }
    return [];
  }

  // Build a quote lookup for every leg symbol in one batch call
  const allSymbols = positions.map(p => p.symbol);
  const quotes     = await getOptionQuote(allSymbols);
  const quoteMap   = {};
  for (const q of quotes) quoteMap[q.symbol] = q;

  // Group Tradier position rows by which internal trade they belong to.
  // Untracked legs are collected by ticker+expiry for inline reconciliation.
  const grouped    = new Map();
  const untrackedByKey = {}; // key: "TICKER:YYMMDD" — prevents merging SPY Aug5 + SPY Aug10

  for (const pos of positions) {
    const ourTrade = state.openPositions.find(t => t.legs?.some(l => l.symbol === pos.symbol));
    if (!ourTrade) {
      // Collect untracked legs — group by TICKER:EXPIRY not just ticker
      // (confirmed Aug 4 2026: ticker-only grouping merged SPY Aug 5 orphan
      // legs + SPY Aug 10 IC into a fake 6-leg trade with -829% P&L)
      const underlying  = pos.symbol.match(/^[A-Z]+/)?.[0] || pos.symbol;
      const expiryMatch = pos.symbol.match(/[A-Z]+(\d{6})[CP]/);
      const key = `${underlying}:${expiryMatch ? expiryMatch[1] : "000000"}`;
      if (!untrackedByKey[key]) untrackedByKey[key] = { underlying, legs: [] };
      untrackedByKey[key].legs.push(pos);
      continue;
    }

    if (!grouped.has(ourTrade)) grouped.set(ourTrade, { positions: [], netValue: 0, missingQuote: false });
    const g = grouped.get(ourTrade);
    g.positions.push(pos);
    const quote = quoteMap[pos.symbol];
    if (!quote) { g.missingQuote = true; continue; }
    const legSign = pos.quantity > 0 ? 1 : -1;
    g.netValue += legSign * (quote.bid + quote.ask) / 2;
  }

  // ── INLINE RECONCILIATION: re-track untracked positions mid-session ──
  const inlineRestored = [];
  for (const { underlying, legs } of Object.values(untrackedByKey)) {
    const rebuilt = rebuildTradeFromPositions(underlying, legs);
    if (!rebuilt) {
      console.error(`  ⚠ Inline restore failed for ${underlying} (${legs.length} legs)`);
      continue;
    }
    // Skip expired — they linger in Tradier until settlement but restoring
    // them every 20min cycle would spam notifications and trigger bogus closes.
    const expDate = new Date(rebuilt.expiration + "T00:00:00Z");
    if (expDate < new Date()) {
      console.log(`  ⏭ Skipping inline restore for ${underlying} ${rebuilt.strategy} — expired ${rebuilt.expiration}`);
      continue;
    }
    state.openPositions.push(rebuilt);
    inlineRestored.push(`${underlying} ${rebuilt.strategy}`);
    console.log(`  🔄 Inline restore: ${underlying} ${rebuilt.strategy} (${legs.length} legs) — now monitored`);
    // Add to grouped so it's monitored THIS cycle, not just the next
    if (!grouped.has(rebuilt)) grouped.set(rebuilt, { positions: [], netValue: 0, missingQuote: false });
    const g2 = grouped.get(rebuilt);
    for (const pos of legs) {
      g2.positions.push(pos);
      const q2 = quoteMap[pos.symbol];
      if (!q2) { g2.missingQuote = true; continue; }
      g2.netValue += (pos.quantity > 0 ? 1 : -1) * (q2.bid + q2.ask) / 2;
    }
  }
  if (inlineRestored.length > 0) {
    saveState();
    await sendSMS(`🔄 INLINE POSITION RESTORE\n${inlineRestored.length} untracked position(s) auto-recovered mid-session:\n\n${inlineRestored.join("\n")}\n\nMonitoring (breach, DTE, stop) now active.\nNot financial advice.`);
  }

  // Convert to results array
  const results = [];
  for (const [ourTrade, g] of grouped.entries()) {
    if (g.missingQuote) { results.push({ ourTrade, positions: g.positions, valid: false }); continue; }
    const qty          = ourTrade.quantity || Math.abs(g.positions[0]?.quantity || 1);
    const currentValue = Math.abs(g.netValue);
    results.push({ ourTrade, positions: g.positions, valid: true, currentValue, qty });
  }

  // ── STALE POSITION CLEANUP ─────────────────────────────────────
  // GRACE PERIOD (Aug 4 2026): Tradier has a fill-to-position lag for
  // multileg condors — legs placed at 9:10 AM weren't visible in the
  // positions endpoint at 9:20 AM, causing all 3 ICs to be wiped.
  // Trades placed within 60 min are never marked stale.
  const STALE_GRACE_MS = 60 * 60 * 1000;
  const nowMs          = Date.now();
  const trulyGrouped   = new Set(grouped.keys());

  const staleTrades = state.openPositions.filter(t => {
    if (trulyGrouped.has(t)) return false;
    const ageMs = t.executedAt ? nowMs - new Date(t.executedAt).getTime() : Infinity;
    if (ageMs < STALE_GRACE_MS) {
      console.log(`  ⏳ ${t.ticker} ${t.strategy}: no Tradier match yet (placed ${Math.round(ageMs/60000)}min ago — within 60-min grace, keeping)`);
      return false;
    }
    return true;
  });

  if (staleTrades.length > 0) {
    for (const stale of staleTrades) {
      console.error(`  🧹 STALE: ${stale.ticker} ${stale.strategy} — no Tradier legs found after grace period, removing from tracking`);
    }
    state.openPositions = state.openPositions.filter(t => !staleTrades.includes(t));
    await sendSMS(`🧹 STALE POSITION CLEANUP\n${staleTrades.map(t=>`${t.ticker} ${t.strategy}`).join(", ")}\n\nNo matching legs in Tradier after 60min — assumed closed.\nVerify P&L manually.\nNot financial advice.`);
    saveState();
  }

  return results;
}

function getLivePositionSnapshot(groups) {
  if (!groups || !groups.length) {
    return { hasPositions: false, summary: "No open positions.", totalPnL: 0, lines: [] };
  }

  const lines = [];
  let totalPnL = 0;
  let totalCost = 0;

  for (const g of groups) {
    const { ourTrade } = g;
    if (!g.valid) {
      lines.push(`${ourTrade.ticker} ${ourTrade.strategy}: ⚠️ quote unavailable for one or more legs`);
      continue;
    }

    const { currentPnL, currentPct } = computePnL(ourTrade, g);

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

async function sendLiveSnapshot(groups) {
  // Accepts pre-fetched groups from the same cycle — no second Tradier round-trip.
  // Filter to trades still open (monitorOpenPositions may have closed some this cycle).
  const stillOpen = (groups || []).filter(g => state.openPositions.includes(g.ourTrade));
  const snap = getLivePositionSnapshot(stillOpen);

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

async function monitorOpenPositions(groups, priceMap = {}) {
  if (!groups || !groups.length) return;
  console.log(`  Monitoring ${groups.length} open trade(s) (grouped by all legs)...`);

  for (const g of groups) {
    const { ourTrade } = g;
    try {
      if (!g.valid) {
        console.log(`  ⚠ ${ourTrade.ticker} ${ourTrade.strategy}: quote unavailable for one or more legs — skipping this cycle`);
        continue;
      }

      const { currentPnL, currentPct, profitTargetPnL, maxProfitShare } = computePnL(ourTrade, g);

      // DTE: compare date strings as UTC midnight to avoid timezone skew.
      // new Date("2026-08-10") parses as UTC midnight; subtracting a local
      // Date() gives off-by-one errors on non-UTC servers. String comparison avoids it.
      const todayStr = new Date().toISOString().slice(0, 10);
      const expDate  = new Date(ourTrade.expiration + "T00:00:00Z");
      const todayUTC = new Date(todayStr + "T00:00:00Z");
      const dte      = Math.ceil((expDate - todayUTC) / (1000*60*60*24));

      console.log(`  ${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs): net value $${g.currentValue.toFixed(2)}/sh | P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%) | DTE:${dte}`);

      const debitStopLossPnL  = -(ourTrade.executedCost * (MANDATE.stopLossPct / 100));
      const creditStopLossPnL = -(maxProfitShare * g.qty * 100 * (MANDATE.creditStopLossPct / 100));

      // BREACHED STRIKE CHECK — Lesson from PANW (Jul): an Iron Condor can
      // still be inside the dollar stop-loss threshold while the underlying
      // has already traded beyond a short strike, at which point the trade
      // is structurally compromised and rarely recovers.
      // Uses the pre-fetched priceMap (passed from intradayCheck) rather than
      // fetchStockPrice() — the cache TTL (18 min) is shorter than the cycle
      // interval (20 min), meaning fetchStockPrice was frequently returning
      // prices from the PREVIOUS cycle. priceMap is fetched fresh this cycle.
      let strikeBreached = false;
      if (ourTrade.strategy === "Iron Condor" && ourTrade.shortCallStrike && ourTrade.shortPutStrike) {
        const livePrice = priceMap?.[ourTrade.ticker]?.price;
        if (livePrice) {
          if (livePrice >= ourTrade.shortCallStrike) {
            strikeBreached = true;
            console.log(`  🚨 ${ourTrade.ticker} price $${livePrice} breached short CALL strike $${ourTrade.shortCallStrike}`);
          } else if (livePrice <= ourTrade.shortPutStrike) {
            strikeBreached = true;
            console.log(`  🚨 ${ourTrade.ticker} price $${livePrice} breached short PUT strike $${ourTrade.shortPutStrike}`);
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
        // Close EVERY leg of this trade together — never leave a partial spread open.
        // 500ms between legs (was 300ms) + logging the ACTUAL error text per leg —
        // previously only a count of failures was logged, making a real diagnosis
        // impossible. Root cause suspected but NOT yet confirmed: the close orders
        // hit /accounts/{id}/orders (a trading endpoint), whose rate limit was never
        // separately verified from the /markets data endpoint's documented 60/min —
        // 4 positions all exiting in the same cycle could burst 14+ close orders in
        // a few seconds. This logging will confirm or rule that out next occurrence.
        const closeResults = [];
        for (const pos of g.positions) {
          const result = await closeOptionsPosition({ symbol:pos.symbol, underlyingSymbol:ourTrade.ticker, quantity:Math.abs(pos.quantity), side:pos.quantity>0?"buy_to_open":"sell_to_open" });
          if (!result.success) {
            console.error(`  ✗ Close failed for ${pos.symbol}: ${result.error}`);
          }
          closeResults.push(result);
          await new Promise(r => setTimeout(r, 500));
        }
        const allClosed = closeResults.every(r => r.success);
        if (allClosed) {
          state.dailyPnL += currentPnL;
          state.openPositions = state.openPositions.filter(t => t !== ourTrade);
          await sendSMS(`◈ POSITION CLOSED\n${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs closed)\n${closeReason}\n\nP&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%)\nToday's P&L: ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}\n\nNot financial advice.`);
        } else {
          // CRITICAL: some legs failed to close — do NOT remove from tracking.
          // Keep monitoring so we retry closing the remaining legs next cycle.
          const failedCount   = closeResults.filter(r => !r.success).length;
          const failureReasons = closeResults.filter(r => !r.success).map(r => r.error).join(" | ");
          console.error(`  🚨 PARTIAL CLOSE FAILURE: ${failedCount}/${g.positions.length} legs failed to close on ${ourTrade.ticker}. Reasons: ${failureReasons}. Trade remains tracked for retry.`);
          await sendSMS(`🚨 PARTIAL CLOSE ALERT\n${ourTrade.ticker} ${ourTrade.strategy}\n${failedCount} of ${g.positions.length} legs failed to close.\nReason: ${failureReasons.slice(0,200)}\nBot will retry next cycle.`);
        }
        // Small pause between DIFFERENT positions closing in the same monitoring
        // cycle — same burst-risk precaution, applied at the position level too.
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error(`  ✗ Monitor ${ourTrade?.ticker || "unknown"}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ═══════════════════════════════════════════════════════════════
// ANALYST TARGET AUTO-UPDATE (runs daily 9:15 AM)
// ═══════════════════════════════════════════════════════════════

// ── ETF tickers — use price-based levels, not analyst targets ──
// Only tickers that are actually in PORTFOLIO — XLE/IWM/DIA removed
// (were never in PORTFOLIO; caused silent no-ops in the ETF update loop).
const ETF_TICKERS = ["SPY", "QQQ"];
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
    const drop = (stock.avgCost - live.price) / stock.avgCost;
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

  try {
    const msg = await retryAI(() => ai.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 2000,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages:   [{ role: "user", content: prompt }],
    }));
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

  saveState(); // persist updated stops/targets
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
  let balanceFetchFailed = false;
  try { balances = await getAccountBalances(); } catch(e) {
    console.log(`  ⚠ Balances unavailable: ${e.message}`);
    balanceFetchFailed = true;
  }
  const buyingPower = balances?.option_buying_power || balances?.cash || 0;

  // In live mode, if we can't verify buying power, abort rather than risk
  // placing trades the account can't cover. Sandbox has no real capital so
  // it's fine to proceed with buyingPower=0 there.
  if (!TRADIER.sandbox && balanceFetchFailed) {
    const msg = "⚠️ MORNING SESSION ABORTED\nCould not verify account balance — refusing to place trades blind in live mode.\nCheck Tradier API connectivity and redeploy if needed.";
    console.error(`  🛑 ${msg}`);
    await sendSMS(msg);
    return;
  }

  const portfolioData = await fetchAllPrices();
  const modeFlag      = TRADIER.sandbox ? " [SANDBOX]" : "";

  // Regime signal sourced from already-fetched portfolioData — no
  // separate network call, no external dependency that can silently fail.
  const spyNow    = getSpyChangeFromPortfolio(portfolioData);
  const regimeNow = getMarketRegime(spyNow);
  console.log(`  📊 Regime: ${regimeNow.label} | SPY: ${spyNow.toFixed(2)}%`);

  // Generate trades — retry up to 3x on network/connection errors ONLY.
  // Previously: `while (trades.length === 0)` retried even when the AI
  // legitimately returned no qualifying setups — burning 90s of delays and
  // 3 AI calls on quiet days where no trades pass the mandate filter.
  let trades = [];
  let scanAttempt = 0;
  while (scanAttempt < 3) {
    scanAttempt++;
    try {
      trades = await generateTrades(portfolioData, { spyChange: spyNow, regime: regimeNow });
      break; // success — empty result is valid, don't retry
    } catch(e) {
      // Match retryAI conditions exactly — previously missing ENOTFOUND, timeout, 503, 529
      const isRetryable = e.message.includes("Connection error") ||
                          e.message.includes("ECONNREFUSED") ||
                          e.message.includes("ENOTFOUND") ||
                          e.message.includes("fetch failed") ||
                          e.message.includes("network") ||
                          e.message.includes("timeout") ||
                          e.status === 529 ||
                          e.status === 503;
      if (!isRetryable || scanAttempt === 3) {
        await sendSMS(`⚠️ Morning scan failed after ${scanAttempt} attempt(s): ${e.message}`);
        return;
      }
      const wait = scanAttempt * 30000;
      console.log(`  ⚠ Morning scan attempt ${scanAttempt} failed — retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  const executed = [];
  for (const trade of trades) {
    if (state.totalDeployedToday >= MANDATE.dailyCapMax) break;
    const stockData = portfolioData.find(p => p.ticker === trade.ticker);
    if (!stockData?.price) continue;

    // Skip tickers already in an open position — prevents doubling up if
    // morning session and opportunistic scan both recommend the same ticker.
    if (state.openPositions.some(p => p.ticker === trade.ticker)) {
      console.log(`  ⏭  ${trade.ticker} — already have an open position, skipping`);
      continue;
    }

    const legs = await buildOptionsLegs(trade, stockData.price, regimeNow);
    if (!legs) { console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — buildOptionsLegs returned null, skipping (see rejection reason above)`); continue; }
    if (legs.cost < MANDATE.minPerTrade || legs.cost > MANDATE.maxPerTrade) {
      console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — cost $${legs.cost} outside mandate range $${MANDATE.minPerTrade}-$${MANDATE.maxPerTrade}, skipping`);
      continue;
    }

    // Buying power gate (live only — sandbox has no real capital constraint).
    // For Cash Secured Puts, check COLLATERAL (strike × 100 × qty), not the
    // premium collected. A 10-contract CSP at a $120 strike requires $120,000
    // in cash, not the $420 credit. buildOptionsLegs sets legs.collateral only
    // for CSPs; for all other strategies it's undefined, so we fall back to
    // legs.cost (the debit paid). This check runs AFTER buildOptionsLegs so
    // that legs.collateral is available — previously it ran before, which made
    // legs undefined and threw a ReferenceError on every live morning session.
    if (!TRADIER.sandbox && buyingPower > 0) {
      const capitalRequired = legs.collateral ?? legs.cost;
      if (capitalRequired > buyingPower - state.totalDeployedToday) {
        console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — insufficient buying power ($${(buyingPower - state.totalDeployedToday).toFixed(0)} remaining, need $${capitalRequired}${legs.collateral ? " collateral" : ""})`);
        continue;
      }
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

  const regimeFlag = regimeNow.label !== "NORMAL" ? `\nRegime: ${regimeNow.label} (SPY ${spyNow.toFixed(1)}%)` : "";
  const msg = executed.length > 0
    ? `◈ MORNING${modeFlag}${regimeFlag} ${new Date().toLocaleDateString()}\n\n${executed.length} TRADES EXECUTED:\n${executed.map((t,i)=>`${i+1}. ${t.ticker} ${t.strategy}\n   Cost: $${t.executedCost} | Target: ${t.targetReturnPct}%\n   Expiry: ${t.expiration} | Order: ${t.orderId}`).join("\n\n")}\n\nDeployed: $${state.totalDeployedToday}\nMonitoring every 20 min. Auto-close at ${MANDATE.profitTargetPct}% profit.\n\nNot financial advice.`
    : `◈ MORNING${modeFlag} ${new Date().toLocaleDateString()}\n\nNo trades executed — no setups met the 8% mandate.\nMonitoring continues.\n\nNot financial advice.`;
  await sendSMS(msg);
  saveState(); // persist any new trades before this cycle ends
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
  const spyNow = getSpyChangeFromPortfolio(portfolioData);
  const regime = getMarketRegime(spyNow);

  if (regime.skipTrading) {
    console.log(`  ⏭  Skipping — regime is ${regime.label}, no new trades`);
    return;
  }

  // Generate a trade recommendation using the same AI + mandate logic
  let trades = [];
  try {
    trades = await generateTrades(portfolioData, { spyChange: spyNow, regime });
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

  // Final guard: don't add a second position in the same ticker
  if (state.openPositions.some(p => p.ticker === candidate.ticker)) {
    console.log(`  ⏭  ${candidate.ticker} — already have an open position, skipping opportunistic entry`);
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
    saveState(); // persist the new trade immediately
  } else {
    console.log(`  ✗ Order failed: ${result.error}`);
  }
}

async function intradayCheck() {
  console.log(`\n[${new Date().toLocaleTimeString()}] ⚡ Intraday check...`);

  // Fetch prices FIRST so breach checks in monitorOpenPositions use
  // current-cycle data. Previously fetchAllPrices ran AFTER monitoring,
  // meaning breach checks called fetchStockPrice() which returned prices
  // from the 18-min cache — potentially a full cycle (20 min) stale.
  const portfolioData = await fetchAllPrices();
  const priceMap = Object.fromEntries(portfolioData.map(p => [p.ticker, p]));

  // Fetch positions once and pass to both monitor and snapshot.
  const groups = await getGroupedLivePositions();
  await monitorOpenPositions(groups, priceMap);
  saveState();

  if (state.openPositions.length > 0) {
    console.log(`  📊 Sending live snapshot for ${state.openPositions.length} open position(s)...`);
    await sendLiveSnapshot(groups);
  }

  for (const stock of portfolioData) {
    if (!stock.price) continue;
    const alerts = detectAlerts(stock);
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
  saveState(); // persist end-of-day state
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

  // Reset weekly highs at the start of each new week. The momentum filter in
  // buildOptionsLegs uses state.weeklyHighs to gate directional spreads —
  // without a weekly reset, a peak from weeks ago would permanently block
  // Bull Call Spreads on any ticker that has since pulled back.
  const prevHighCount = Object.keys(state.weeklyHighs).length;
  state.weeklyHighs = {};
  console.log(`  🔄 Weekly highs reset (${prevHighCount} ticker(s) cleared — momentum filter will rebuild from today's prices)`);

  // Check for splits FIRST — must happen before pricing update
  await detectAndFixSplits(portfolioData);
  await updateAllPricingLevels(portfolioData);

  const lines = portfolioData.map(p => {
    const price      = p.price || 0;
    const stop       = getStopLoss(p.ticker, p.stopLoss);
    const target     = getTarget(p.ticker, p.target);
    const dynamic    = state.dynamicLevels[p.ticker];
    // Use split-adjusted avgCost from dynamicLevels if available —
    // detectAndFixSplits updates it there; PORTFOLIO.avgCost is static.
    const costBasis  = dynamic?.avgCost || p.avgCost;
    const pnlPct     = costBasis ? (((price - costBasis) / costBasis) * 100).toFixed(1) : "N/A";
    const distToStop   = stop   ? (((price-stop)/price)*100).toFixed(1)    : "N/A";
    const distToTarget = target ? (((target-price)/price)*100).toFixed(1)  : "N/A";
    return `${p.ticker}: $${price.toFixed(2)} (${parseFloat(pnlPct)>=0?"+":""}${pnlPct}%)\n  Stop: $${stop?.toFixed(2)||"N/A"} (${distToStop}% away)${dynamic?.stopLoss?" 📈auto":""}\n  Target: $${target?.toFixed(2)||"N/A"} (${distToTarget}% up)${dynamic?.target?" 🔄updated":""}`;
  }).join("\n\n");

  const autoStops   = Object.values(state.dynamicLevels).filter(l=>l.stopLoss).length;
  const autoTargets = Object.values(state.dynamicLevels).filter(l=>l.target).length;

  await sendSMS(`📋 SUNDAY REVIEW\n${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}\n\nAUTO-UPDATES:\n📈 Trailing stops: ${autoStops}\n🔄 Analyst targets: ${autoTargets}\n\n${lines}\n\n📈=auto stop 🔄=updated target\nNot financial advice.`);
  saveState();
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
console.log("⏰ Schedule:");
console.log("   Mon–Fri 9:10 AM — Morning scan + execute");
console.log("   Mon–Fri 9:25 AM — Analyst targets refresh");
console.log("   Mon–Fri 9:30–4PM — Position monitor + trailing stops every 20 min");
console.log("   Mon–Fri 11:02,1:02,3:02 — Opportunistic scan (5%+ moves only)");
console.log("   Mon–Fri 4:05 PM — Closing summary");
console.log("   Sunday 8:00 AM  — Full portfolio review + auto-update all levels\n");

// ═══════════════════════════════════════════════════════════════
// ORPHANED POSITION RECONCILIATION
// Runs once at boot: fetches real Tradier positions, compares against
// state.openPositions (restored from disk or empty after first boot),
// and auto-retracks anything found in Tradier that the bot doesn't
// know about — with a push notification summarising what was recovered.
// ═══════════════════════════════════════════════════════════════
async function reconcileOrphanedPositions() {
  console.log("\n🔍 Checking for orphaned Tradier positions (untracked after restart)...");
  try {
    const positions = await getTradierPositions();
    if (positions === null) {
      console.log("  ⚠ Tradier positions fetch failed — skipping reconciliation this cycle.");
      return;
    }
    if (!positions.length) {
      console.log("  ✓ No open Tradier positions — nothing to reconcile.");
      return;
    }

    // Group by ticker+expiry — NOT just ticker. Confirmed Aug 4 2026:
    // ticker-only grouping merged SPY Aug5 orphan legs + SPY Aug10 IC
    // into a fake 6-leg "Iron Condor" with -829% P&L on retrack.
    const byKey = {};
    for (const pos of positions) {
      const underlying  = pos.symbol.match(/^[A-Z]+/)?.[0] || pos.symbol;
      const expiryMatch = pos.symbol.match(/[A-Z]+(\d{6})[CP]/);
      const key = `${underlying}:${expiryMatch ? expiryMatch[1] : "000000"}`;
      if (!byKey[key]) byKey[key] = { underlying, legs: [] };
      byKey[key].legs.push(pos);
    }

    const reTracked      = [];
    const orphanSummaries = [];

    for (const { underlying, legs } of Object.values(byKey)) {
      const allTracked = legs.every(pos => state.openPositions.some(t => t.legs?.some(l => l.symbol === pos.symbol)));
      if (allTracked) continue;

      const rebuilt = rebuildTradeFromPositions(underlying, legs);
      if (rebuilt) {
        const expDate = new Date(rebuilt.expiration + "T00:00:00Z");
        if (expDate < new Date()) {
          console.log(`  ⏭ Skipping retrack for ${underlying} — expired ${rebuilt.expiration}`);
          continue;
        }
        state.openPositions.push(rebuilt);
        reTracked.push(
          `${underlying} ${rebuilt.strategy} (${legs.length} legs, exp ${rebuilt.expiration})` +
          (rebuilt.shortCallStrike ? ` SC:$${rebuilt.shortCallStrike}` : "") +
          (rebuilt.shortPutStrike  ? ` SP:$${rebuilt.shortPutStrike}`  : "")
        );
        console.log(`  ✅ Re-tracked orphaned ${underlying} ${rebuilt.strategy} — ${legs.length} legs`);
      } else {
        orphanSummaries.push(`${underlying}: ${legs.length} leg(s) — could not auto-retrack`);
      }
    }

    if (reTracked.length > 0) {
      saveState();
      await sendSMS(`✅ ORPHANED POSITIONS RE-TRACKED\nBot restarted and recovered ${reTracked.length} position(s):\n\n${reTracked.join("\n")}\n\nMonitoring (stop-loss, profit-target, breach) now active.\nCost basis reconstructed from Tradier — P&L estimates approximate.\nNot financial advice.`);
    }

    if (orphanSummaries.length > 0) {
      console.error(`  🚨 ${orphanSummaries.length} orphaned position(s) could not be auto-retracked:`);
      orphanSummaries.forEach(s => console.error(`     ${s}`));
      await sendSMS(`🚨 ORPHANED POSITIONS DETECTED\n${orphanSummaries.join("\n")}\n\nThese are REAL open positions in Tradier with NO automated protection. Close or manage manually.`);
    }

    if (reTracked.length === 0 && orphanSummaries.length === 0) {
      console.log(`  ✓ All ${positions.length} live Tradier position(s) are properly tracked.`);
    }
  } catch(e) {
    console.error(`  ✗ Reconciliation check failed: ${e.message}`);
  }
}

// Schedules
cron.schedule("10 9 * * 1-5",      () => runExclusive("morningSession",       morningSession),       { timezone:"America/New_York" });
cron.schedule("25 9 * * 1-5",      () => runExclusive("updateAnalystTargets", updateAnalystTargets), { timezone:"America/New_York" });
cron.schedule("*/20 9-16 * * 1-5", () => runExclusive("intradayCheck",        intradayCheck),        { timezone:"America/New_York" });

// Opportunistic mid-day scan: 11:02 AM, 1:02 PM, 3:02 PM ET Mon-Fri.
// CONFIRMED BUG (Jul 27 2026 live log): this used to fire at :00 exactly,
// the SAME minute as intradayCheck's */20 schedule, every single day.
// Since intradayCheck is registered first, it deterministically won the
// runExclusive lock every time — opportunisticScan was skipped at BOTH
// 11:00 and 1:00 today, missing a real AMD reversal (premarket +3% to
// intraday -7%) that was exactly the kind of setup this scan exists to
// catch. Offsetting by 2 minutes guarantees no collision, ever.
cron.schedule("2 11,13,15 * * 1-5", () => runExclusive("opportunisticScan",    opportunisticScan),    { timezone:"America/New_York" });
cron.schedule("5 16 * * 1-5",      () => runExclusive("closingSession",       closingSession),       { timezone:"America/New_York" });
cron.schedule("0 8 * * 0",         () => runExclusive("sundaySummary",        sundaySummary),        { timezone:"America/New_York" });

// ── SECURE BOOT ──────────────────────────────────────────────
// Wraps startup work so cron schedules survive any transient network
// error on boot. The startup notification fires AFTER reconciliation
// and the first intraday check complete — previously it fired before
// both, so the user got "BOT ACTIVE" followed by "ORPHANED POSITIONS"
// which implied the bot was running fine when it had just started.
(async () => {
  try {
    console.log("  ⏳ Running startup diagnostics...");
    // Restore state BEFORE reconciliation — so a legitimate restart with
    // a working persisted state finds its own positions already tracked,
    // rather than falsely flagging them as orphaned.
    loadState();
    await reconcileOrphanedPositions();
    await runExclusive("startupDiagnostics", intradayCheck);
    console.log("  🚀 Diagnostics clear. Background crons running.");

    // Send the startup notification AFTER diagnostics — user should only
    // see "BOT ACTIVE" once the system has verified its state.
    await sendSMS(`◈ OPTIONS BOT v2 ACTIVE (${modeLabel})
Portfolio: ${PORTFOLIO.filter(p=>p.optionable).map(p=>p.ticker).join(", ")}
${PORTFOLIO.length} stocks | ${PORTFOLIO.filter(p=>p.ivProfile==="high").length} high-IV names
Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day | $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | ${MANDATE.minReturnPct}%+ return
Auto-execute: ENABLED | Broker: Tradier ${modeLabel}
Trailing stops: ENABLED | Analyst targets: AUTO-UPDATE

Schedule: 9:10AM execute | 9:25 targets | 20min monitor | 4PM close | Sun 8AM review`);

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
