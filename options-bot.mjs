// ================================================================
// OPTIONS TRADING BOT v3 — LONG CALLS AND PUTS
// ================================================================
// Portfolio : 22 stocks — NVDA AMD AVGO ARM MRVL MSFT AAPL AMZN
//             GOOGL META TSLA PANW CRWD COIN HOOD OKLO VST LLY
//             PLTR NOW SPY QQQ
// Strategies: Long Call (bullish) | Long Put (bearish)
//             AI selects direction based on momentum and technicals
//             No premium selling — no collateral required
// Mandate   : $300–$1,000/trade · $1,000–$3,000/day
//             2–7% OTM · 14–21 DTE · trail from +20%
//             50% stop loss · 2 DTE time stop
// Execution : Tradier API (sandbox or live)
// Alerts    : Pushover push notifications
// Schedule  : 9:10AM execute | 5min monitor | 4PM close | Sun review
// Upgraded from v2 (CSP/IC) Aug 2026 — see archive/v2-csp-ic/
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
  // ── Capital ──────────────────────────────────────────────
  dailyCapMin:      1000,  // minimum to deploy per day ($)
  dailyCapMax:      3000,  // maximum to deploy per day ($)
  minPerTrade:       250,  // minimum cost per option purchase ($) — lowered from $300
                           // $300 was rejecting valid $290-$299 setups on a $6 difference.
                           // Quality is controlled by setupScore, not an arbitrary floor.
  maxPerTrade:      1000,  // maximum cost per option purchase ($)
  minPerTradeLive:   250,  // same floor in live

  // ── Option selection ─────────────────────────────────────
  targetMinDTE:       14,  // buy options with at least 14 DTE — enough time for move
  targetMaxDTE:       21,  // cap at 21 DTE — beyond this theta is too slow to decay
  otmPctMin:           2,  // minimum 2% OTM — close to the money, high delta (0.40–0.48)
  otmPctMax:           7,  // maximum 7% OTM — still meaningful delta, moves with the stock
                           // Previously 10–15% OTM — delta too low (0.15–0.25), needed huge
                           // moves to reach the +20% trail activation. At 2–7% OTM a 5–8%
                           // move in the underlying produces a 20–40% gain on the option.

  // ── Exit rules ───────────────────────────────────────────
  // Upside: trailing stop activates at +20% gain.
  // Trail tightens as profit grows — see monitorOpenPositions for tiers.
  trailActivationPct:   20,  // trail kicks in once position gains 20%
  trailWidthTier1:      10,  // +20–50% peak: 10% pullback from peak closes (was 15%)
  trailWidthTier2:       8,  // +50–100% peak: 8% pullback from peak closes (was 12%)
  trailWidthTier3:       6,  // +100%+ peak: 6% pullback from peak closes (was 10%)
                             // Tightened alongside 5-minute monitoring interval (Aug 2026).
                             // At 5-min checks, whipsaw risk is lower — tighter trails
                             // lock in more profit without frequently closing healthy positions.

  // Downside: tiered stop loss — grace period early, tighten late.
  stopLossPct:          50,  // standard stop after 48h (option halved)
  stopLossGracePct:     70,  // first 48h only close on catastrophic loss
  stopLossLatePct:      35,  // DTE ≤ 7: tighten (theta crush, unlikely to recover)
  gracePeriodHours:     48,  // how long the wider grace stop applies
  lateStopDTE:           7,  // DTE threshold that triggers the tighter late stop

  timeDTE:               2,  // time stop — close all positions at 2 DTE regardless

  // ── Quality filters ───────────────────────────────────────
  minReturnPct:       20,  // AI must project 20%+ upside — matches trail activation threshold.
  minSetupScore:       8,  // minimum AI conviction score out of 10 — raised from 7.
                           // Live data: losing trades had scores of 7. Winning trades (COIN
                           // +123%, PLTR +22%) had scores of 8-9. Score 7 was too permissive
                           // in a weak market — quality gate needs to be tighter.

  // ── Risk management ───────────────────────────────────────
  maxOpenPositions:    4,  // max concurrent option positions — reduced from 6.
                           // With 6 positions open in a weak market all 6 lose simultaneously.
                           // 4 positions keeps exposure manageable and forces selectivity.
  broadWeaknessThreshold: 4, // if this many tickers have consecutive stop losses, the AI
                           // prompt is flagged with bearish bias — favour puts over calls.
                           // Based on live data: when 4+ names hit STOP_LOSS on the same day,
                           // the broad market is in a sustained downtrend, not isolated weakness.
  dailyMaxLoss:     2000,  // circuit breaker: halt new trades if day P&L hits -$2,000.

  // ── Trailing stops (underlying stock monitoring) ──────────
  trailPctHighIV:     15,
  trailPctMediumIV:   10,
};

// ── INDEX TICKERS ─────────────────────────────────────────────
// SPY and QQQ — included in the portfolio for directional plays on
// broad market moves. In v2 these were the only valid Iron Condor
// vehicles. In v3 (long calls/puts) they are treated like any other
// ticker but useful for macro regime trades (e.g. SPY put in a
// HIGH VOLATILITY regime when broad market weakness is expected).
const INDEX_TICKERS = ["SPY", "QQQ"];

// ── TRADIER ───────────────────────────────────────────────────
const TRADIER = {
  sandbox: process.env.TRADIER_SANDBOX !== "false",
  get baseUrl() { return this.sandbox ? "https://sandbox.tradier.com/v1" : "https://api.tradier.com/v1"; },
  token:     process.env.TRADIER_ACCESS_TOKEN,
  accountId: process.env.TRADIER_ACCOUNT_ID,
};

// ── PORTFOLIO — Last reviewed Aug 14 2026 ─────────────────────
// 22 high-IV, liquid options stocks. All meet: daily volume >10K,
// ATM spread <$0.15, weekly expiries available.
// Added Aug 14 2026: COIN, HOOD, ARM, MRVL, VST.
// Earnings dates confirmed or estimated to Q3/Q4 2026.
const PORTFOLIO = [
  // ── AI / SEMICONDUCTORS — highest IV, most profitable ─────
  { ticker:"NVDA", name:"Nvidia",                 shares:0,    avgCost:198.00, stopLoss:175.00, target:236.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true,  earningsDate:"2026-11-19" }, // Q3 FY2027 est.
  { ticker:"AMD",  name:"Advanced Micro Devices", shares:0,    avgCost:546.72, stopLoss:420.00, target:580.00,  sector:"Semis",     ivProfile:"high",   optionable:true,  earningsDate:"2026-10-27" }, // stop lowered Aug 2026 — sustained weakness below $480 original stop
  { ticker:"AVGO", name:"Broadcom Inc",           shares:0,    avgCost:400.39, stopLoss:340.00, target:472.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true,  earningsDate:"2026-09-04" }, // upcoming

  // ── MEGA-CAP TECH — deepest liquidity, weekly expiries ────
  { ticker:"MSFT", name:"Microsoft",              shares:0,    avgCost:365.44, stopLoss:460.00, target:560.00,  sector:"Cloud/AI",  ivProfile:"high",   optionable:true,  earningsDate:"2026-10-23" }, // Q1 FY2027 est. | stop/target updated Aug 2026
  { ticker:"AAPL", name:"Apple Inc",              shares:0,    avgCost:298.01, stopLoss:255.00, target:350.00,  sector:"Consumer",  ivProfile:"medium", optionable:true,  earningsDate:"2026-11-01" }, // stop lowered Aug 2026 — weakness near $277 original stop
  { ticker:"AMZN", name:"Amazon",                 shares:0,    avgCost:244.00, stopLoss:208.00, target:310.00,  sector:"Cloud/AI",  ivProfile:"high",   optionable:true,  earningsDate:"2026-10-30" }, // Q3 2026 est.
  { ticker:"GOOGL",name:"Alphabet",               shares:0,    avgCost:357.18, stopLoss:314.00, target:410.00,  sector:"AI/Ads",    ivProfile:"high",   optionable:true,  earningsDate:"2026-10-27" }, // Q3 2026 est.
  { ticker:"META", name:"Meta Platforms",         shares:0,    avgCost:620.00, stopLoss:540.00, target:680.00,  sector:"AI/Social", ivProfile:"high",   optionable:true,  earningsDate:"2026-10-28" }, // Q3 2026 est. | target updated Aug 2026

  // ── HIGH VOLATILITY ───────────────────────────────────────
  { ticker:"TSLA", name:"Tesla",                  shares:0,    avgCost:375.53, stopLoss:320.00, target:440.00,  sector:"EV/Tech",   ivProfile:"high",   optionable:true,  earningsDate:"2026-10-21" }, // Q3 2026 est.

  // ── CYBERSECURITY ─────────────────────────────────────────
  { ticker:"PANW", name:"Palo Alto Networks",     shares:0,    avgCost:325.91, stopLoss:286.00, target:370.00,  sector:"Cyber",     ivProfile:"high",   optionable:true,  earningsDate:"2026-09-10" }, // FQ4 2026 est.
  { ticker:"CRWD", name:"CrowdStrike",            shares:0,    avgCost:187.23, stopLoss:165.00, target:235.00,  sector:"Cyber",     ivProfile:"high",   optionable:true,  earningsDate:"2026-11-25" },  // Q2 FY2027 est. 4-for-1 split completed Jul 2026

  // ── CRYPTO ADJACENT / HIGH-IV FINTECH ────────────────────
  // COIN: $148 Aug 14 2026. 52-wk $139–$402. High-IV crypto-adjacent name.
  //   Q2 missed badly (EPS -$1.36 vs -$0.01 est); Q3 earnings Oct 29 2026
  //   (confirmed). Strong directional mover — COIN Long Call placed Aug 2026
  //   closed at +123% gain. Treat with respect: moves 5-10%+ on BTC headlines.
  { ticker:"COIN", name:"Coinbase Global",        shares:0, avgCost:148.00, stopLoss:118.00, target:220.00,  sector:"Crypto/Fintech", ivProfile:"high",   optionable:true, earningsDate:"2026-10-29" }, // Q3 2026 confirmed
  // HOOD: $95.75 Aug 14 2026. 52-wk $63–$153. Post-Q2 selloff (reported
  //   Jul 29). Crypto/retail correlated — moves with COIN. Record Q2
  //   revenue but stock repriced lower. High IV, very active options flow.
  //   Analyst targets $115–$170; BofA raised to $140 post-Q2.
  //   Q3 earnings est Oct 28 2026 (based on historical cadence).
  { ticker:"HOOD", name:"Robinhood Markets",      shares:0, avgCost:95.75,  stopLoss:72.00,  target:135.00,  sector:"Crypto/Fintech", ivProfile:"high",   optionable:true, earningsDate:"2026-10-28" }, // Q3 2026 est.

  // ── SEMICONDUCTOR IP / AI NETWORKING ─────────────────────
  // ARM: ~$340 Aug 14 2026 (range $325–$358 per Coinbase data). Fell 34%
  //   in July AI selloff, now recovering above $280. AGI CPU order book
  //   >$2B; data-center royalties doubled Q1 FY2027 (ended Jun 2026).
  //   P/E 178x — priced for AI dominance. Q2 FY2027 est Nov 5 2026
  //   (ARM fiscal year ends March; Q2 FY2027 = Jul–Sep 2026).
  //   High IV post-selloff bounce; valid for directional long options in v3.
  { ticker:"ARM",  name:"Arm Holdings",           shares:0, avgCost:340.00, stopLoss:268.00, target:430.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true, earningsDate:"2026-11-05" }, // Q2 FY2027 est.
  // MRVL: ~$187 Aug 14 2026 (bounced from $163 July low; spiked to $220s
  //   on new AI memory platform). EARNINGS AUG 27 2026 (CONFIRMED) — that
  //   is 13 days away. Earnings block will fire in 7 days for income trades.
  //   Do not open new CSPs within 7 days of Aug 27. AI networking / custom
  //   ASIC for hyperscalers. Goldman raising targets; strong AI narrative.
  //   Beta 1.53; Q3 FY2027 est Dec 3 2026 after Aug 27 Q2 report.
  { ticker:"MRVL", name:"Marvell Technology",     shares:0, avgCost:187.00, stopLoss:155.00, target:270.00,  sector:"AI/Semis",  ivProfile:"high",   optionable:true, earningsDate:"2026-08-27" }, // Q2 FY2027 CONFIRMED — 13 days out
  // VST: $146 Aug 14 2026. 52-wk $132–$219. Q2 adj EBITDA +30% YoY to
  //   $1.77B; data center power deals driving narrative. Analyst consensus
  //   target ~$221 (20 analysts, Strong Buy). Wells Fargo $212, BofA $196,
  //   MS $212. Lower IV than pure tech but elevated for a utility — same
  //   AI-power thesis as OKLO but far more liquid and dividend-paying.
  //   Medium IV; CSPs on pullbacks near support $132. Q3 est Nov 6 2026.
  { ticker:"VST",  name:"Vistra Corp",            shares:0, avgCost:146.00, stopLoss:122.00, target:215.00,  sector:"Energy/AI", ivProfile:"medium", optionable:true, earningsDate:"2026-11-06" }, // Q3 2026 est.

  // ── INDEX ETFs — 0DTE capable, deepest liquidity ─────────
  { ticker:"SPY",  name:"S&P 500 ETF",            shares:0,    avgCost:754.95, stopLoss:680.00, target:820.00,  sector:"Index",     ivProfile:"medium", optionable:true,  earningsDate:null },
  { ticker:"QQQ",  name:"Nasdaq 100 ETF",         shares:0,    avgCost:725.51, stopLoss:653.00, target:790.00,  sector:"Index",     ivProfile:"medium", optionable:true,  earningsDate:null },

  // ── EXISTING HOLDINGS ─────────────────────────────────────
  { ticker:"OKLO", name:"Oklo Inc",               shares:150,  avgCost:68.38,  stopLoss:42.00,  target:88.00,   sector:"Nuclear",   ivProfile:"high",   optionable:true,  earningsDate:"2026-11-12" }, // Q3 2026 est.
  { ticker:"LLY",  name:"Eli Lilly",              shares:4.02, avgCost:987.00, stopLoss:1045.00,target:1350.00, sector:"Pharma",    ivProfile:"medium", optionable:true,  earningsDate:"2026-10-29" }, // Q3 2026 est.
  { ticker:"PLTR", name:"Palantir",               shares:13,   avgCost:135.00, stopLoss:105.00, target:183.00,  sector:"AI/Gov",    ivProfile:"medium", optionable:true,  earningsDate:"2026-11-03" }, // Q3 2026 est.
  // NOTE: NOW did 5-for-1 split in 2025. Price $107.71. Down 42% YTD.
  { ticker:"NOW",  name:"ServiceNow",             shares:0,    avgCost:107.71, stopLoss:88.00,  target:142.00,  sector:"SaaS",      ivProfile:"medium", optionable:true,  earningsDate:"2026-10-22" }, // Q3 2026 est.
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
  weeklyPnL:          0,    // resets every Sunday
  monthlyPnL:         0,    // resets on first trading day of each month
  totalDeployedToday: 0,
  dynamicLevels:      {},   // auto-updated stops + targets
  weeklyHighs:        {},   // highest price seen this week
  tradeStats:         {},   // per-strategy win/loss tracking
  downtrendCount:     {},   // { ticker: { count: N, lastDate: "YYYY-MM-DD" } }
                            // increments each day STOP_LOSS fires; resets on TARGET_HIT.
                            // In v3 (long calls/puts) this is INFORMATIONAL ONLY — the
                            // counter is tracked but does not block any trade decisions.
                            // In v2 (CSP), count >= 3 blocked put selling on the ticker.
                            // Kept in v3 for future strategy use and historical continuity.
  _lastResetMonth:      null,
  jobRunning:           null,
  totalCollateralToday: 0,  // Total capital committed today across all trades.
                            // For long options: the full cost paid (no collateral concept).
                            // Tracked alongside totalDeployedToday for the buying power gate
                            // and AI prompt accuracy.
  dailyCircuitBreakerTripped: false, // Set true when realized+unrealized P&L hits -dailyMaxLoss.
                            // Halts all new trades for the rest of the day. Resets each morning.
  _saveStateAlertSent:  false, // One-time flag — prevent spamming Pushover on every saveState
                            // call if the Volume is unmounted. Resets on successful write.
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

const STATE_FILE    = process.env.STATE_FILE_PATH    || "/data/bot-state.json";

// ── PERSISTENT TRADE HISTORY ──────────────────────────────────
// Newline-delimited JSON (NDJSON) — each closed trade appended as one
// JSON line. Survives restarts indefinitely. Enables analysis queries
// like "win rate by ticker" or "avg hold time by strategy" that
// state.tradeStats counters alone can't answer (they reset mid-session).
// Requires the same Railway Volume mount as STATE_FILE.
const TRADE_LOG_FILE = process.env.TRADE_LOG_FILE_PATH || "/data/trade-log.ndjson";

function appendTradeLog(entry) {
  try {
    fs.appendFileSync(
      TRADE_LOG_FILE,
      JSON.stringify({ ...entry, loggedAt: new Date().toISOString() }) + "\n"
    );
  } catch(e) {
    // Non-fatal — state.tradeStats still captures aggregates.
    // Don't alert: the Volume failure alert in saveState covers this.
    console.error(`  ✗ Trade log write failed: ${e.message}`);
  }
}

function saveState() {
  try {
    const persistable = {
      openPositions:              state.openPositions,
      dailyTrades:                state.dailyTrades,
      totalDeployedToday:         state.totalDeployedToday,
      totalCollateralToday:       state.totalCollateralToday,
      dailyCircuitBreakerTripped: state.dailyCircuitBreakerTripped,
      dailyPnL:                   state.dailyPnL,
      weeklyPnL:                  state.weeklyPnL,
      monthlyPnL:                 state.monthlyPnL,
      tradeStats:                 state.tradeStats,
      downtrendCount:             state.downtrendCount,
      _lastResetMonth:            state._lastResetMonth,
      dynamicLevels:              state.dynamicLevels,
      weeklyHighs:                state.weeklyHighs,
      alertsSent:                 [...state.alertsSent],
      savedAt:                    new Date().toISOString(),
    };
    // Write to temp file then atomically rename — prevents a partial
    // write (crash mid-write, disk full) from corrupting the live state.
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(persistable, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    // Successful write — clear the alert flag so a subsequent failure still fires.
    state._saveStateAlertSent = false;
  } catch(e) {
    console.error(`  ✗ Failed to save state to ${STATE_FILE}: ${e.message}`);
    // Alert once per outage — avoids spamming Pushover on every 20-min cycle.
    // The flag is only reset when a write succeeds (above), so repeated failures
    // stay silent after the first alert until the Volume comes back.
    if (!state._saveStateAlertSent) {
      state._saveStateAlertSent = true;
      sendSMS(
        `🚨 STATE PERSISTENCE FAILURE\n${e.message}\n\n` +
        `All open position tracking will be LOST on next restart.\n` +
        `Check Railway Volume mount immediately — the bot is running without persistence.`
      ).catch(() => {});
    }
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
    state.tradeStats        = persisted.tradeStats    || {};
    state.downtrendCount    = persisted.downtrendCount || {};
    state._lastResetMonth   = persisted._lastResetMonth || null;
    state.weeklyPnL         = persisted.weeklyPnL     || 0;
    state.monthlyPnL        = persisted.monthlyPnL    || 0;
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
      state.dailyTrades                = persisted.dailyTrades || [];
      state.totalDeployedToday         = persisted.totalDeployedToday || 0;
      state.totalCollateralToday       = persisted.totalCollateralToday || 0;
      state.dailyPnL                   = persisted.dailyPnL || 0;
      state.dailyCircuitBreakerTripped = persisted.dailyCircuitBreakerTripped || false;
    } else {
      // New day — daily counters stay at their initialised-zero defaults.
      // Explicitly false here prevents a stale persisted true from bleeding
      // into the next day if the state file's savedAt is somehow mid-day.
      state.dailyCircuitBreakerTripped = false;
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
    // Log the full stack — console is the primary diagnostic surface.
    console.error(`  ✗ ${jobName} crashed: ${e.message}\n${e.stack || "(no stack)"}`);
    // Alert for session-level jobs: a silent crash in morningSession or
    // closingSession means trades were not placed / positions not closed
    // with no indication to the operator. Even non-critical jobs that crash
    // unexpectedly are worth knowing about immediately.
    await sendSMS(
      `🚨 ${jobName} CRASHED\n${e.message.slice(0, 300)}\n\n` +
      `Crons are still running. Check Railway logs for full stack.\n` +
      (CRITICAL_ONCE_DAILY_JOBS.has(jobName)
        ? `⚠️ This job does NOT retry — manual check needed.`
        : `Next scheduled run will retry automatically.`)
    ).catch(() => {}); // never let the alert itself crash the finally block
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

// ── SHARED UTILITY HELPERS ────────────────────────────────────

// Strategy name → compact abbreviation used in all Pushover messages.
// Single source of truth — previously copy-pasted identically in three
// places (morningSession, closingSession, sundaySummary). One place to
// update when a new strategy is added.
function abbrevStrategy(s) {
  return s
    .replace("Long Call",        "LC")
    .replace("Long Put",         "LP")
    .replace("Cash Secured Put", "CSP")
    .replace("Iron Condor",      "IC")
    .replace("Bull Call Spread", "BCS")
    .replace("Bear Put Spread",  "BPS");
}

// Classifies an error as a transient network failure safe to retry.
// Used by retryAI (AI SDK errors) and the morningSession scan loop
// (generateTrades errors). Previously duplicated verbatim in both places —
// any update to one had to be manually mirrored to the other.
function isRetryableError(e) {
  return e.message.includes("Connection error") ||
         e.message.includes("ECONNREFUSED")     ||
         e.message.includes("ENOTFOUND")        ||
         e.message.includes("fetch failed")     ||
         e.message.includes("network")          ||
         e.message.includes("timeout")          ||
         e.status === 529                        ||
         e.status === 503;
}

// Maximum age of a cached price before it is considered too stale to use
// as a fallback. 30 minutes covers a transient Tradier blip without letting
// the bot make stop-loss or profit-target decisions on hours-old data.
const MAX_CACHE_AGE_MS = 30 * 60 * 1000;

// How long after placement before a tracked trade is considered stale if
// Tradier has no matching position. Tradier has a fill-to-position lag —
// confirmed Aug 18 2026: trades filled at 9:10 were not visible in the
// positions endpoint at 9:20. Both stale-cleanup paths must use this same
// constant so the grace window is consistent across the whole codebase.
const STALE_GRACE_MS = 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════
// DYNAMIC LEVEL HELPERS — auto trailing stops + analyst targets
// ═══════════════════════════════════════════════════════════════

function getStopLoss(ticker, staticStop) {
  return state.dynamicLevels[ticker]?.stopLoss ?? staticStop;
}

function getTarget(ticker, staticTarget) {
  return state.dynamicLevels[ticker]?.target ?? staticTarget;
}

function updateTrailingStop(ticker, currentPrice, staticStop) {
  if (!currentPrice) return { updated: false };
  const weekHigh = state.weeklyHighs[ticker] || currentPrice;
  if (currentPrice > weekHigh) state.weeklyHighs[ticker] = currentPrice;

  // Trail distance is IV-profile-aware: high-IV names (NVDA, TSLA, COIN…)
  // need a wider trail because their normal daily range is 3-5%. A 10% trail
  // would stop them out on routine volatility. Medium-IV names (AAPL, MSFT,
  // VST…) rarely move >2% per day, so 10% gives clean signal without noise.
  const ivProfile      = PORTFOLIO.find(p => p.ticker === ticker)?.ivProfile || "high";
  const trailPct       = ivProfile === "high" ? MANDATE.trailPctHighIV : MANDATE.trailPctMediumIV;
  const currentStop    = getStopLoss(ticker, staticStop);
  const newTrailingStop = parseFloat((currentPrice * (1 - trailPct / 100)).toFixed(2));

  if (newTrailingStop > currentStop) {
    const oldStop = currentStop;
    state.dynamicLevels[ticker] = {
      ...(state.dynamicLevels[ticker] || {}),
      stopLoss:    newTrailingStop,
      lastUpdated: new Date().toISOString(),
    };
    console.log(`  📈 ${ticker} trailing stop: $${oldStop} → $${newTrailingStop} (${trailPct}% trail, ${ivProfile}-IV, price $${currentPrice})`);
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

  // Live mode: use midpoint limit order to avoid bid-ask slippage.
  // Market orders on options in live mode can give back $10-50+ per leg
  // on the spread. placeOptionsOrder already uses limits for opens —
  // closes should match. Falls back to market if quote fetch fails.
  let orderType  = "market";
  let limitPrice;
  if (!TRADIER.sandbox) {
    try {
      const quotes = await getOptionQuote(position.symbol);
      const q      = quotes[0];
      if (q?.bid != null && q?.ask != null && q.bid > 0) {
        limitPrice = ((q.bid + q.ask) / 2).toFixed(2);
        orderType  = "limit";
      }
    } catch(e) {
      console.log(`  ⚠ Quote fetch failed for ${position.symbol} — falling back to market close`);
    }
  }

  const orderParams = {
    class:"option", symbol:position.underlyingSymbol || position.ticker,
    option_symbol:position.symbol, side:closeSide,
    quantity:Math.abs(position.quantity), type:orderType, duration:"day",
    ...(limitPrice ? { price: limitPrice } : {}),
  };

  // Retry up to 3 times with backoff — Tradier sandbox occasionally rejects
  // close orders on first submission due to transient liquidity/matching issues,
  // then accepts on retry. Confirmed Aug 7 2026: SPY $712P and AMZN spread
  // each rejected 3-4 times before eventually filling. Without retries the bot
  // was removing positions from tracking after the first rejection and then
  // inline-restoring them every 20-min cycle indefinitely.
  //
  // CRITICAL (Aug 14 2026): before each retry, check whether the previous order
  // is still open/pending. If it is, do NOT submit a duplicate. AMZN IC generated
  // 5 duplicate close orders because all retries submitted unconditionally —
  // a pending order is not a rejection; duplicates all eventually fill.
  let lastOrderId = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1 && lastOrderId && !TRADIER.sandbox) {
      try {
        const statusData  = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/orders/${lastOrderId}`);
        const orderStatus = statusData?.order?.status;
        console.log(`  🔍 Close order ${lastOrderId} status: ${orderStatus}`);
        if (orderStatus === "filled") {
          console.log(`  ✅ Close order ${lastOrderId} already filled — no retry needed`);
          return { success:true, orderId:lastOrderId };
        }
        if (["open","partially_filled","pending"].includes(orderStatus)) {
          console.log(`  ⏳ Close order ${lastOrderId} still ${orderStatus} — waiting, not submitting duplicate`);
          await new Promise(r => setTimeout(r, attempt * 5000));
          continue;
        }
        console.log(`  ↩ Close order ${lastOrderId} is ${orderStatus} — submitting new close order`);
      } catch(statusErr) {
        console.log(`  ⚠ Could not check status of order ${lastOrderId}: ${statusErr.message} — proceeding with retry`);
      }
    }

    try {
      const data    = await tradierRequest("POST", `/accounts/${TRADIER.accountId}/orders`, orderParams);
      const orderId = data?.order?.id;
      const status  = data?.order?.status;

      if (!orderId) {
        console.error(`  ✗ Close attempt ${attempt}: no order ID returned`);
      } else if (status && status !== "ok") {
        console.error(`  ✗ Close attempt ${attempt}: order ${orderId} rejected (status: ${status})`);
        lastOrderId = orderId;
      } else {
        lastOrderId = orderId;
        console.log(`  ✅ Close order accepted: ${orderId}`);
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
      return dte >= 5 && dte <= MANDATE.targetMaxDTE;
    });
    if (!validExp) return null;

    const chain = await getOptionChain(ticker, validExp);
    if (!chain.length) return null;

    const calls = chain.filter(o => o.option_type==="call").sort((a,b) => a.strike-b.strike);
    const puts  = chain.filter(o => o.option_type==="put").sort((a,b) => b.strike-a.strike);

    switch(strategy) {
      case "Long Call": {
        // Find expiry in the 14-21 DTE window
        const lcExp = expirations.find(exp => {
          const dte = Math.ceil((new Date(exp + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
          return dte >= MANDATE.targetMinDTE && dte <= MANDATE.targetMaxDTE;
        });
        if (!lcExp) {
          console.log(`  ✗ ${ticker} Long Call REJECTED — no expiry in ${MANDATE.targetMinDTE}–${MANDATE.targetMaxDTE} DTE window`);
          return null;
        }
        const lcChain = lcExp === validExp ? chain : await getOptionChain(ticker, lcExp);
        const lcCalls = lcChain.filter(o => o.option_type === "call").sort((a,b) => a.strike - b.strike);

        // Target strike: 10–15% OTM
        const minStrike = stockPrice * (1 + MANDATE.otmPctMin / 100);
        const maxStrike = stockPrice * (1 + MANDATE.otmPctMax / 100);
        const lcStrike  = lcCalls.find(c => c.strike >= minStrike && c.strike <= maxStrike && c.ask > 0);
        if (!lcStrike) {
          console.log(`  ✗ ${ticker} Long Call REJECTED — no call strike in ${MANDATE.otmPctMin}–${MANDATE.otmPctMax}% OTM range ($${minStrike.toFixed(0)}–$${maxStrike.toFixed(0)})`);
          return null;
        }

        // Quantity: how many contracts fit within the budget.
        // Math.floor means if 1 contract costs more than targetCost, we still
        // buy 1 (Math.max(1,0)=1) and spend more than the AI intended.
        // The mandate range check below catches anything outside $300-$1000.

        // ── REAL-TIME QUOTE REFRESH ──────────────────────────────────
        // The option chain was fetched seconds-to-minutes ago. For near-money
        // options (2-7% OTM) a $0.10 move in the ask changes cost by $10-20
        // per contract. Fetch a fresh single-symbol quote right now — before
        // the order is placed — to get the actual current market price.
        // In live mode this also gives us the bid for midpoint limit pricing.
        let freshAsk  = lcStrike.ask;
        let freshBid  = lcStrike.bid ?? 0;
        let limitPrice = null;
        try {
          const freshQuotes = await getOptionQuote(lcStrike.symbol);
          const fq = freshQuotes[0];
          if (fq?.ask > 0) {
            if (fq.ask !== lcStrike.ask) {
              console.log(`  🔄 ${ticker} Long Call: ask refreshed $${lcStrike.ask} → $${fq.ask} (live quote)`);
            }
            freshAsk = fq.ask;
            freshBid = fq.bid ?? 0;
          }
        } catch(e) {
          console.log(`  ⚠ ${ticker} Long Call: live quote failed (${e.message}) — using chain price $${lcStrike.ask}`);
        }
        // Limit price for live orders: midpoint of fresh bid/ask, rounded to $0.05
        // Midpoint avoids paying the full spread; $0.05 rounding matches most options markets.
        if (!TRADIER.sandbox && freshBid > 0 && freshAsk > freshBid) {
          const mid = (freshBid + freshAsk) / 2;
          limitPrice = parseFloat((Math.round(mid / 0.05) * 0.05).toFixed(2));
          console.log(`  💲 ${ticker} Long Call: limit price $${limitPrice} (mid of bid $${freshBid} / ask $${freshAsk})`);
        }

        const costPerContract = freshAsk * 100;
        if (costPerContract <= 0) return null;
        const qty       = Math.max(1, Math.floor(tradeRec.targetCost / costPerContract));
        const totalCost = costPerContract * qty;
        if (qty === 1 && totalCost > tradeRec.targetCost * 1.2) {
          console.log(`  ⚠ ${ticker} Long Call: AI targetCost $${tradeRec.targetCost} but cheapest option is $${totalCost} — proceeding if within mandate range`);
        }
        if (totalCost < MANDATE.minPerTrade || totalCost > MANDATE.maxPerTrade) {
          console.log(`  ✗ ${ticker} Long Call REJECTED — ${qty} contract(s) × $${costPerContract.toFixed(0)} = $${totalCost.toFixed(0)} outside $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade} range`);
          return null;
        }

        const dte = Math.ceil((new Date(lcExp + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
        console.log(`  📐 Long Call: ${ticker} $${lcStrike.strike}C exp ${lcExp} (${dte} DTE, ${((lcStrike.strike/stockPrice-1)*100).toFixed(1)}% OTM) × ${qty} @ $${freshAsk} = $${totalCost.toFixed(0)}`);

        return {
          expiration: lcExp,
          legs:       [{ symbol: lcStrike.symbol, side: "buy_to_open" }],
          cost:       Math.round(totalCost),
          limitPrice,           // fresh midpoint for live limit orders; null in sandbox
          maxProfit:  null,
          quantity:   qty,
          isCredit:   false,
          strike:     lcStrike.strike,
          optionType: "call",
        };
      }

      case "Long Put": {
        // Find expiry in the 14-21 DTE window
        const lpExp = expirations.find(exp => {
          const dte = Math.ceil((new Date(exp + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
          return dte >= MANDATE.targetMinDTE && dte <= MANDATE.targetMaxDTE;
        });
        if (!lpExp) {
          console.log(`  ✗ ${ticker} Long Put REJECTED — no expiry in ${MANDATE.targetMinDTE}–${MANDATE.targetMaxDTE} DTE window`);
          return null;
        }
        const lpChain = lpExp === validExp ? chain : await getOptionChain(ticker, lpExp);
        const lpPuts  = lpChain.filter(o => o.option_type === "put").sort((a,b) => b.strike - a.strike);

        // Target strike: 2–7% OTM (below current price for puts)
        const maxStrikeP = stockPrice * (1 - MANDATE.otmPctMin / 100);
        const minStrikeP = stockPrice * (1 - MANDATE.otmPctMax / 100);
        const lpStrike   = lpPuts.find(p => p.strike <= maxStrikeP && p.strike >= minStrikeP && p.ask > 0);
        if (!lpStrike) {
          console.log(`  ✗ ${ticker} Long Put REJECTED — no put strike in ${MANDATE.otmPctMin}–${MANDATE.otmPctMax}% OTM range ($${minStrikeP.toFixed(0)}–$${maxStrikeP.toFixed(0)})`);
          return null;
        }

        // ── REAL-TIME QUOTE REFRESH ──────────────────────────────────
        let freshAskP  = lpStrike.ask;
        let freshBidP  = lpStrike.bid ?? 0;
        let limitPriceP = null;
        try {
          const freshQuotesP = await getOptionQuote(lpStrike.symbol);
          const fqp = freshQuotesP[0];
          if (fqp?.ask > 0) {
            if (fqp.ask !== lpStrike.ask) {
              console.log(`  🔄 ${ticker} Long Put: ask refreshed $${lpStrike.ask} → $${fqp.ask} (live quote)`);
            }
            freshAskP = fqp.ask;
            freshBidP = fqp.bid ?? 0;
          }
        } catch(e) {
          console.log(`  ⚠ ${ticker} Long Put: live quote failed (${e.message}) — using chain price $${lpStrike.ask}`);
        }
        if (!TRADIER.sandbox && freshBidP > 0 && freshAskP > freshBidP) {
          const midP = (freshBidP + freshAskP) / 2;
          limitPriceP = parseFloat((Math.round(midP / 0.05) * 0.05).toFixed(2));
          console.log(`  💲 ${ticker} Long Put: limit price $${limitPriceP} (mid of bid $${freshBidP} / ask $${freshAskP})`);
        }

        const costPerContractP = freshAskP * 100;
        if (costPerContractP <= 0) return null;
        const qtyP       = Math.max(1, Math.floor(tradeRec.targetCost / costPerContractP));
        const totalCostP = costPerContractP * qtyP;
        if (qtyP === 1 && totalCostP > tradeRec.targetCost * 1.2) {
          console.log(`  ⚠ ${ticker} Long Put: AI targetCost $${tradeRec.targetCost} but cheapest option is $${totalCostP} — proceeding if within mandate range`);
        }
        if (totalCostP < MANDATE.minPerTrade || totalCostP > MANDATE.maxPerTrade) {
          console.log(`  ✗ ${ticker} Long Put REJECTED — ${qtyP} contract(s) × $${costPerContractP.toFixed(0)} = $${totalCostP.toFixed(0)} outside $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade} range`);
          return null;
        }

        const dteP = Math.ceil((new Date(lpExp + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
        console.log(`  📐 Long Put: ${ticker} $${lpStrike.strike}P exp ${lpExp} (${dteP} DTE, ${((1-lpStrike.strike/stockPrice)*100).toFixed(1)}% OTM) × ${qtyP} @ $${freshAskP} = $${totalCostP.toFixed(0)}`);

        return {
          expiration: lpExp,
          legs:       [{ symbol: lpStrike.symbol, side: "buy_to_open" }],
          cost:       Math.round(totalCostP),
          limitPrice: limitPriceP,  // fresh midpoint for live limit orders; null in sandbox
          maxProfit:  Math.round(lpStrike.strike * 100 * qtyP),
          quantity:   qtyP,
          isCredit:   false,
          strike:     lpStrike.strike,
          optionType: "put",
        };
      }

      default:
        console.log(`  ✗ Unknown strategy "${strategy}" — only Long Call and Long Put are supported in v3`);
        return null;
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
    // Only use cached entries that are fresher than MAX_CACHE_AGE_MS (30 min).
    // A 3-hour-old NVDA price during an active market move is worse than no price —
    // it would trigger false stop-loss or profit-target checks silently.
    // Entries that are too stale are dropped; those positions skip this cycle.
    const now = Date.now();
    const fresh = PORTFOLIO
      .map(s => {
        const cached = state.priceCache[s.ticker];
        if (!cached) return null;
        if (now - cached.ts > MAX_CACHE_AGE_MS) {
          console.warn(`  ⚠ ${s.ticker} cache entry is ${Math.round((now - cached.ts)/60000)}min old — too stale, dropping`);
          return null;
        }
        return { ...s, ...cached.data };
      })
      .filter(Boolean);
    console.log(`  ⚠ Using ${fresh.length} fresh cache entries (${PORTFOLIO.length - fresh.length} dropped as stale)`);
    return fresh;
  }
}

// ═══════════════════════════════════════════════════════════════
// PUSHOVER NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

async function sendSMS(body) {
  try {
    // Pushover hard-caps messages at 1024 characters. Long messages (Sunday
    // summary with 22 portfolio lines, morning session with 6+ trades) overflow
    // silently. Append a visible marker so the reader knows data was cut.
    const LIMIT    = 1024;
    const ELLIPSIS = "\n…[truncated]";
    const message  = body.length > LIMIT
      ? body.slice(0, LIMIT - ELLIPSIS.length) + ELLIPSIS
      : body;
    if (body.length > LIMIT) {
      console.warn(`  ⚠ Push notification truncated: ${body.length} → ${LIMIT} chars`);
    }
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method:  "POST",
      headers: { "Content-Type":"application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        token:   PUSHOVER.token,
        user:    PUSHOVER.user,
        message,
        title:   "Options Bot",
        sound:   "cashregister",
      }).toString(),
    });
    const data = await res.json();
    if (data.status === 1) console.log(`  ✅ Push notification sent`);
    else console.error(`  ✗ Pushover failed:`, data.errors);
  } catch(e) { console.error(`  ✗ Push failed: ${e.message}`); }
}

// Sends an array of messages sequentially with a short delay between each.
// Use instead of multiple bare sendSMS calls whenever a session needs to
// split a long summary into parts — keeps the call-site readable and
// ensures Pushover doesn't receive concurrent requests from the same process.
async function sendParts(parts, delayMs = 2000) {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) await sendSMS(parts[i]);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }
}

// ═══════════════════════════════════════════════════════════════
// MARKET SENTIMENT — SPY day change used as regime signal
// Used by generateTrades to adjust strategy selection and
// condor wing width based on current market conditions.
// (Alpha Vantage VIX/SPY fetching retired Jul 29 2026 — see
//  getMarketRegime for full history of why VIX was dropped)
// ═══════════════════════════════════════════════════════════════

// VIX_REGIME history:
// - Originally used Alpha Vantage GLOBAL_QUOTE for ^VIX — always failed
//   (^VIX is not a valid symbol for that endpoint). VIX defaulted to 18
//   every session so regime was always NORMAL. Retired Jul 29 2026.
// - Re-added Aug 2026 via Tradier /markets/quotes?symbols=VIX — now
//   optional (fails gracefully to null) and used to widen IC wings when
//   IV is elevated and skip condors when premium is too thin (VIX < 15).
//   See fetchVIX() and getMarketRegime() for full implementation.

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
// failure. SPY's move is a well-established, highly-correlated
// proxy for broad market volatility.
//
// VIX was re-added Aug 2026 via Tradier /markets/quotes?symbols=VIX
// as a SECONDARY signal — it widens IC wings when IV is elevated
// and halts all trading when VIX > 40 (crash-level fear). VIX is
// optional and fails gracefully; the regime works without it.
// ═══════════════════════════════════════════════════════════════

function getSpyChangeFromPortfolio(portfolioData) {
  const spy = portfolioData.find(p => p.ticker === "SPY");
  if (!spy || spy.changePct == null) {
    console.log(`  ⚠ SPY not found in portfolio data — defaulting regime signal to 0%`);
    return 0;
  }
  return spy.changePct;
}

// ═══════════════════════════════════════════════════════════════
// VIX FETCH — real-time fear/greed gauge for regime calibration.
// In v3 (long calls/puts): high VIX means expensive options but
// bigger moves. Low VIX means cheap options but smaller moves.
// ═══════════════════════════════════════════════════════════════
async function fetchVIX() {
  try {
    const data = await tradierRequest("GET", "/markets/quotes", { symbols: "VIX", greeks: "false" });
    const q    = data?.quotes?.quote;
    const vix  = q?.last ?? q?.close;
    if (vix && vix > 0) {
      console.log(`  📊 VIX: ${parseFloat(vix).toFixed(2)}`);
      return parseFloat(vix);
    }
  } catch(e) {
    console.log(`  ⚠ VIX fetch failed (${e.message}) — regime will use SPY-only signals`);
  }
  return null; // graceful fallback — regime still works without VIX
}

function getVIXLabel(vix) {
  if (!vix)     return { label:"UNKNOWN",  note:"VIX unavailable" };
  if (vix > 40) return { label:"CRASH",    note:`VIX ${vix.toFixed(1)} — crash-level fear. Puts expensive. No new positions.` };
  if (vix > 30) return { label:"EXTREME",  note:`VIX ${vix.toFixed(1)} — extreme fear. Options very expensive. Only highest-conviction setups.` };
  if (vix > 20) return { label:"ELEVATED", note:`VIX ${vix.toFixed(1)} — elevated. Options moderately expensive. Favour 10% OTM over 15%.` };
  if (vix > 15) return { label:"NORMAL",   note:`VIX ${vix.toFixed(1)} — normal. Standard option pricing.` };
  return         { label:"LOW",      note:`VIX ${vix.toFixed(1)} — low. Options cheap. Moves may be smaller than expected.` };
}

function getMarketRegime(spyChangePct, vix = null) {
  // Compute VIX label FIRST — needed by every regime path including
  // early returns. Previously computed after the SPY<-3% check, meaning
  // the SPY-triggered EXTREME FEAR returned without a vix field while
  // the VIX-triggered EXTREME FEAR did have one — inconsistent shapes.
  const vixInfo = getVIXLabel(vix);

  if (spyChangePct < -5.0) {
    return {
      label:            "MARKET CRASH",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         false,
      skipTrading:      true,   // SPY -5%+ intraday = genuine crash event. Gap risk is
                                 // too extreme even for wide-OTM CSPs — a put strike 7%
                                 // below an already-5%-down market can be breached same day.
                                 // Bot halts completely. Resumes tomorrow.
      wingMultiplier:   2.0,
      otmPct:           7,
      vix:              vixInfo,
      note:             `SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note} — CRASH: all trading halted`,
    };
  }

  if (spyChangePct < -3.0) {
    return {
      label:            "EXTREME FEAR",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         false, // v2 field — unused in v3
                                // In v3: EXTREME FEAR = buy puts. Options are expensive
                                // (high IV) but the directional move justifies the cost.
                                // AI prompt tells the model to favour puts in this regime.
      skipTrading:      false,
      wingMultiplier:   2.0,
      otmPct:           7,
      vix:              vixInfo,
      note:             `SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note} — puts favoured, high IV boosts option value`,
    };
  }

  // VIX override: VIX > 40 = extreme systemic fear (2020-style). Halt all trading.
  // VIX > 30 = elevated fear, CSPs still valid. VIX > 40 means gap risk too high.
  if (vix && vix > 40) {
    return {
      label:            "MARKET CRASH",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         false,
      skipTrading:      true,
      wingMultiplier:   2.0,
      otmPct:           7,
      vix:              vixInfo,
      note:             `${vixInfo.note} | SPY ${spyChangePct.toFixed(1)}% — VIX extreme: all trading halted`,
    };
  }

  // VIX 30-40: extreme fear, CSPs only
  if (vix && vix > 30) {
    return {
      label:            "EXTREME FEAR",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   2.0,
      otmPct:           7,
      vix:              vixInfo,
      note:             `${vixInfo.note} | SPY ${spyChangePct.toFixed(1)}% — puts favoured`,
    };
  }

  // v2 condor fields — computed for regime object shape consistency but
  // not read by v3's generateTrades (which only uses regime.label,
  // regime.skipTrading, and regime.vix). Retained to avoid breaking
  // the regime object shape if v2 strategies are restored in future.
  const vixWingBonus  = (vix && vix > 20) ? 0.5  : 0;
  const vixOtmBonus   = (vix && vix > 20) ? 1    : 0;
  const lowVIX        = (vix && vix < 15);

  if (spyChangePct > 1.0) {
    return {
      label:            "STRONG RALLY",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.0 + vixWingBonus,
      otmPct:           3 + vixOtmBonus,
      vix:              vixInfo,
      note:             `SPY +${spyChangePct.toFixed(1)}% | ${vixInfo.note} — calls need strong conviction`,
    };
  }
  if (spyChangePct < -1.0) {
    return {
      label:            "HIGH VOLATILITY",
      allowDirectional: false,
      allowCondors:     false,
      allowCSP:         true,   // CSP is the right play in a down market — collect elevated premium,
                                 // put strike lands below an already-falling stock. Better entry
                                 // than on a calm day with the same strike.
      skipTrading:      false,
      wingMultiplier:   1.5 + vixWingBonus,
      otmPct:           5 + vixOtmBonus,
      vix:              vixInfo,
      note:             `SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note} — puts only on clear breakdown`,
    };
  }
  if (spyChangePct < -0.7) {
    return {
      label:            "ELEVATED VOLATILITY",
      allowDirectional: false,
      allowCondors:     !lowVIX, // skip condors if VIX too low to collect meaningful premium
      allowCSP:         true,
      skipTrading:      false,
      wingMultiplier:   1.25 + vixWingBonus,
      otmPct:           4 + vixOtmBonus,
      vix:              vixInfo,
      note:             `SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note}${lowVIX ? " — options cheap but moves smaller" : ""}`,
    };
  }
  return {
    label:            "NORMAL",
    allowDirectional: false,
    allowCondors:     !lowVIX,
    allowCSP:         true,
    skipTrading:      false,
    wingMultiplier:   1.0 + vixWingBonus,
    otmPct:           3 + vixOtmBonus,
    vix:              vixInfo,
    note:             `SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note}${lowVIX ? " — options cheap, moves may be smaller" : " — all strategies valid"}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// SECTOR CORRELATION CHECK
// Before placing directional spreads, verify the sector isn't
// broadly weak. If 2+ semis are down 2%+, skip all semi directionals.
// ═══════════════════════════════════════════════════════════════

const SECTOR_GROUPS = {
  // ARM and MRVL are IP/networking semis — correlated with NVDA/AMD/AVGO
  // on AI spend headlines even though their business models differ.
  semis:   ["NVDA", "AMD", "AVGO", "ARM", "MRVL"],
  cyber:   ["CRWD", "PANW"],
  megacap: ["MSFT", "AAPL", "AMZN", "GOOGL", "META"],
  ev:      ["TSLA"],
  pharma:  ["LLY"],
  ai:      ["PLTR", "NOW"],
  // COIN and HOOD move together on crypto sentiment + retail trading volume.
  // One weak peer is enough to block the other (2-member group, weakThreshold=1).
  fintech: ["COIN", "HOOD"],
  // VST and OKLO share the AI-datacenter-power narrative — correlated on
  // grid capacity headlines even though OKLO is nuclear and VST is thermal.
  energy:  ["OKLO", "VST"],
  index:   ["SPY", "QQQ"],
};

function checkSectorHealth(ticker, portfolioData) {
  // Find which sector group this ticker belongs to
  const sectorEntry = Object.entries(SECTOR_GROUPS).find(([, tickers]) => tickers.includes(ticker));
  if (!sectorEntry) return { healthy: true, reason: "No sector group" };

  const [sectorName, peers] = sectorEntry;

  // Skip correlation check for single-stock sectors and indexes.
  // "energy" is intentionally NOT in this list — OKLO and VST are both
  // in the energy group and should block each other on correlated weakness.
  // "nuclear" was the old name for a single-member OKLO group; it no longer
  // exists after VST was added and the group was renamed.
  if (["ev", "pharma", "ai", "index"].includes(sectorName)) {
    return { healthy: true, reason: "Single-stock or index sector — no peer correlation check" };
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
      if (!isRetryableError(e) || attempt === maxAttempts) {
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

const HIGH_BETA_TICKERS = ["NVDA", "TSLA", "CRWD", "COIN", "HOOD", "ARM"];
// In v3 (long calls/puts), high-beta names are attractive for directional
// trades but require higher conviction given their speed of loss.

// Minimum AI conviction score required to place a trade.
// Raised from 7→8 (standard) and 8→9 (high-beta) based on live data:
// losing trades had scores of 7, winning trades (COIN +123%, PLTR +22%)
// had scores of 8-9. Higher bar means fewer trades, better trades.
const LONG_OPTIONS_MIN_SCORE = 8;  // standard tickers
const HIGH_BETA_MIN_SCORE    = 9;  // high-beta: NVDA, TSLA, CRWD, COIN, HOOD, ARM

// ── PROMPT BUILDER ────────────────────────────────────────────
function buildTradePrompt({ today, optionable, regime, spyChange, sectorHealth,
                            weakSectors, earningsWarnings, effectiveMin,
                            broadWeakness = false, weakTickers = [] }) {
  const priceLines = optionable.map(p => {
    const health       = sectorHealth[p.ticker];
    const sectorNote   = !health?.healthy ? " ⚠️ SECTOR WEAK" : "";
    const weekHigh     = state.weeklyHighs[p.ticker];
    const pctFromHigh  = weekHigh
      ? (((p.price - weekHigh) / weekHigh) * 100).toFixed(1) : null;
    const momentumNote = pctFromHigh !== null
      ? (parseFloat(pctFromHigh) >= 0
          ? ` | AT WEEK HIGH (+${pctFromHigh}%)`
          : ` | ${pctFromHigh}% from week high`)
      : "";
    const highBetaNote = HIGH_BETA_TICKERS.includes(p.ticker) ? " | HIGH-BETA (score≥8)" : "";
    return `${p.ticker}: $${p.price?.toFixed(2)} ${(p.changePct||0)>=0?"▲":"▼"}${Math.abs(p.changePct||0).toFixed(2)}% | IV:${p.ivProfile} | ${p.sector}${momentumNote}${sectorNote}${highBetaNote}`;
  }).join("\n");

  const regimeNote =
    regime.label === "MARKET CRASH"    ? "🔴 CRASH — puts on SPY/QQQ only, no single names" :
    regime.label === "EXTREME FEAR"    ? "🔴 EXTREME FEAR — puts favoured, calls only on extreme strength" :
    regime.label === "HIGH VOLATILITY" ? "⚠️ HIGH VOL — options expensive. Extra conviction required." :
    regime.label === "STRONG RALLY"    ? "🟢 STRONG RALLY — calls favoured. Avoid puts unless clear breakdown." :
    "🟡 NORMAL — both calls and puts valid based on individual stock setup";

  const openList = state.openPositions.length > 0
    ? "ALREADY OPEN: " + state.openPositions.map(p => `${p.ticker} ${abbrevStrategy(p.strategy)}`).join(", ")
    : "No open positions — full budget available";

  return `You are a directional options trader. Identify the best long call and long put opportunities today.

DATE: ${today}
STRATEGY: Buy long calls (bullish) or long puts (bearish)
BUDGET: $${effectiveMin}–$${MANDATE.maxPerTrade} per trade | $${MANDATE.dailyCapMax - state.totalDeployedToday} remaining today
OPTION SPECS: ${MANDATE.targetMinDTE}–${MANDATE.targetMaxDTE} DTE | ${MANDATE.otmPctMin}–${MANDATE.otmPctMax}% OTM
EXIT RULES: Trail activates at +${MANDATE.trailActivationPct}% gain (${MANDATE.trailWidthTier1}% trail, tightens to ${MANDATE.trailWidthTier2}% at +50%, ${MANDATE.trailWidthTier3}% at +100%) | Stop: -${MANDATE.stopLossGracePct}% first ${MANDATE.gracePeriodHours}h, then -${MANDATE.stopLossPct}%, tightens to -${MANDATE.stopLossLatePct}% at ≤${MANDATE.lateStopDTE} DTE | Close at ${MANDATE.timeDTE} DTE

RETURN TARGET: Minimum ${MANDATE.minReturnPct}%+ projected gain. Trail handles the upside — a setup that can reach +20% and has momentum is worth taking. You do not need to project 100% to propose a trade.

MARKET REGIME: ${regime.label}
SPY Today: ${spyChange.toFixed(2)}%
VIX: ${regime.vix?.note || "unknown"}
DIRECTION GUIDANCE: ${regimeNote}

OPEN POSITIONS: ${state.openPositions.length}/${MANDATE.maxOpenPositions} slots used
${openList}

LIVE PRICES (${optionable.length} stocks):
${priceLines}

${weakSectors.length > 0 ? "⚠️ WEAK SECTORS:\n" + weakSectors.join("\n") + "\n" : ""}${earningsWarnings.length ? "⚠️ EARNINGS WITHIN 5 DAYS (skip — IV inflated for buying):\n" + earningsWarnings.join(", ") : "No earnings this week"}

${broadWeakness
  ? (() => {
      const freshWeak    = weakTickers.filter(t => parseInt(t.match(/\((\d+)d\)/)?.[1]||0) <= 3);
      const extendedWeak = weakTickers.filter(t => parseInt(t.match(/\((\d+)d\)/)?.[1]||0) >  3);
      const severity     = weakTickers.length >= 7 ? "SEVERE" : weakTickers.length >= 5 ? "MODERATE" : "MILD";
      return `🔴 BROAD MARKET WEAKNESS (${severity}) — ${weakTickers.length} tickers in downtrend\n` +
        `Fresh weakness (1-3 days) — BEST PUT CANDIDATES: ${freshWeak.join(", ") || "none"}\n` +
        `Extended downtrend (4+ days) — AVOID FOR PUTS (mean-reversion risk): ${extendedWeak.join(", ") || "none"}\n\n` +
        `RULES IN THIS ENVIRONMENT:\n` +
        `- Favour PUTS on fresh weakness names (1-3 days) — trend just starting\n` +
        `- Avoid puts on extended names (4+ days) — likely to bounce\n` +
        `- Long Calls require score ≥ 9 AND genuine momentum AGAINST the trend\n` +
        `- Score 8 is not enough to go long when ${weakTickers.length} names are in downtrend`;
    })()
  : "✅ No broad weakness — both calls and puts valid based on individual setups"}

BUY CALL when: uptrend, above support, positive momentum, bullish catalyst, healthy sector
BUY PUT when: downtrend, below resistance, negative momentum, bearish catalyst, weak sector

SCORING (setupScore 1-10). Only include score ≥ ${LONG_OPTIONS_MIN_SCORE}. High-beta tickers require ≥ ${HIGH_BETA_MIN_SCORE}.
HIGH-BETA (${HIGH_BETA_TICKERS.join(", ")}): fast movers, great upside — but fast losses too.
IV NOTE: VIX > 20 means expensive options. Only highest-conviction setups. Prefer 10% OTM over 15%.

Return ONLY a valid JSON array. Include 2-4 genuine setups or [] if nothing compelling.

[
  {
    "ticker": "NVDA",
    "strategy": "Long Call",
    "targetCost": 380,
    "targetReturnPct": "20",
    "setupScore": 8,
    "direction": "bullish",
    "reasoning": "NVDA breaking above resistance. AI capex tailwind. Strong semis sector.",
    "catalyst": "AI spending cycle",
    "exitTarget": "Trail activates at +20%, tightens at +50% and +100% — bot manages exit automatically"
  }
]

strategy must be exactly "Long Call" or "Long Put".
targetCost is total dollars to spend ($${effectiveMin}–$${MANDATE.maxPerTrade}).
targetReturnPct is your projected minimum gain — must be "${MANDATE.minReturnPct}" or higher.
Do NOT suggest: Cash Secured Put, Iron Condor, Bull Call Spread, Bear Put Spread.
Do NOT suggest tickers with earnings within 5 days.
Max ${MANDATE.maxOpenPositions - state.openPositions.length} more trades (open slot limit).`;
}

// ── TRADE NORMALISER + FILTER ──────────────────────────────────
// Pure function — testable without AI call.
function normaliseAndFilterTrades(parsed, effectiveMin = MANDATE.minPerTrade, { broadWeakness = false } = {}) {
  if (!Array.isArray(parsed)) return [];

  const normalised = parsed.map(t => ({
    ticker:          t.ticker          ?? "",
    strategy:        t.strategy        ?? "",
    targetCost:      parseFloat(t.targetCost ?? t.cost ?? 0),
    targetReturnPct: parseFloat(t.targetReturnPct ?? t.returnPct ?? "0"),
    setupScore:      parseFloat(t.setupScore ?? t.score ?? 0),
    direction:       t.direction       ?? "unknown",
    reasoning:       t.reasoning       ?? t.rationale ?? t.reason ?? "",
    catalyst:        t.catalyst        ?? "",
    exitTarget:      t.exitTarget      ?? t.exitRule  ?? "",
  }));

  return normalised.filter(t => {
    if (!["Long Call","Long Put"].includes(t.strategy)) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — v3 accepts Long Call/Long Put only`);
      return false;
    }
    if (t.targetCost < effectiveMin || t.targetCost > MANDATE.maxPerTrade) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — cost $${t.targetCost} outside $${effectiveMin}–$${MANDATE.maxPerTrade}`);
      return false;
    }
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) {
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — projected return ${t.targetReturnPct}% below ${MANDATE.minReturnPct}% mandate`);
      return false;
    }
    const earningsDate = EARNINGS[t.ticker];
    if (earningsDate) {
      const todayUTC = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z").getTime();
      const daysOut  = Math.ceil((new Date(earningsDate + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
      if (daysOut > 0 && daysOut <= 5) {
        console.log(`  🚫 Blocked ${t.ticker} — earnings in ${daysOut} days (IV too inflated to buy options)`);
        return false;
      }
    }
    // Score threshold: base is LONG_OPTIONS_MIN_SCORE (8) for standard, HIGH_BETA_MIN_SCORE (9) for high-beta.
    // When broadWeakness is active, Long Calls require score ≥ 9 regardless of ticker —
    // the prompt tells the AI not to propose calls below 9 in a weak market, but the AI
    // may not always comply. This enforces it at the filter level.
    const isCall   = t.strategy === "Long Call";
    const minScore = HIGH_BETA_TICKERS.includes(t.ticker)
      ? HIGH_BETA_MIN_SCORE
      : (broadWeakness && isCall ? 9 : LONG_OPTIONS_MIN_SCORE);
    if (t.setupScore < minScore) {
      const reason = broadWeakness && isCall && minScore === 9
        ? `broad weakness active — calls need score ≥ 9, got ${t.setupScore}`
        : `score ${t.setupScore} below ${minScore} minimum`;
      console.log(`  🚫 Blocked ${t.ticker} ${t.strategy} — ${reason}`);
      return false;
    }
    if (state.openPositions.length >= MANDATE.maxOpenPositions) {
      console.log(`  🚫 Blocked ${t.ticker} — max ${MANDATE.maxOpenPositions} positions already open`);
      return false;
    }
    return true;
  });
}

async function generateTrades(portfolioData, preComputedRegime = null) {
  const optionable  = portfolioData.filter(p => p.optionable && p.price);
  const today       = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const effectiveMin = TRADIER.sandbox ? MANDATE.minPerTrade : MANDATE.minPerTradeLive;

  let spyChange, regime, broadWeakness = false, weakTickers = [];
  if (preComputedRegime) {
    ({ spyChange, regime, broadWeakness = false, weakTickers = [] } = preComputedRegime);
    console.log(`  📊 Using pre-computed regime: ${regime.label} (passed from caller)`);
  } else {
    spyChange = getSpyChangeFromPortfolio(portfolioData);
    const fallbackVix = await fetchVIX();
    regime    = getMarketRegime(spyChange, fallbackVix);
    console.log(`  📊 Market regime: ${regime.label} — ${regime.note}`);
  }

  if (regime.skipTrading && regime.label === "MARKET CRASH") {
    // In a crash, buying calls is foolish and puts are extremely expensive (IV spike).
    // Halt all new positions. Existing positions still monitored and stopped out normally.
    await sendSMS(`⚠️ TRADING HALTED — MARKET CRASH\n${regime.note}\nAll new positions blocked. Existing positions still monitored.\nBot resumes tomorrow morning.`);
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

  // Earnings block: 5 days for long options (IV inflated before reports)
  const todayUTCms = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const earningsWarnings = Object.entries(EARNINGS)
    .map(([t,d]) => ({ t, d, days: Math.ceil((new Date(d + "T00:00:00Z") - todayUTCms) / (1000*60*60*24)) }))
    .filter(e => e.days > 0 && e.days <= 5)
    .map(e => `${e.t} in ${e.days} days`);

  const prompt = buildTradePrompt({
    today, optionable, regime, spyChange, sectorHealth,
    weakSectors, earningsWarnings, effectiveMin,
    broadWeakness, weakTickers,
  });

  // max_tokens raised from 1000 → 3000 → 8192.
  // 3000 was hit Aug 16 2026 after portfolio grew from 17 → 22 tickers:
  // longer prompt in + more candidates out = response truncated mid-JSON,
  // producing "Unexpected end of JSON input" on parse. 8192 is the hard
  // ceiling for this model — safe to set unconditionally.
  const msg = await retryAI(() => ai.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 8192,
    messages:   [{ role: "user", content: prompt }],
  }));

  // Detect truncation before attempting JSON parse. A truncated response
  // always produces "Unexpected end of JSON input" — catching stop_reason
  // here gives a clear message rather than a cryptic parse failure.
  if (msg.stop_reason === "max_tokens") {
    throw new Error("generateTrades response truncated (max_tokens hit) — model hit the 8192 ceiling, reduce prompt size or split the call");
  }

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

  // Match ALL JSON arrays and take the LAST one. The model may emit
  // explanation text containing [...] before the actual data array —
  // the first-match regex would parse the wrong array. The last array
  // in the response is always the structured data payload.
  const allMatches = cleaned.match(/\[[\s\S]*?\]/g);
  const match = allMatches ? allMatches[allMatches.length - 1] : null;
  if (!match) throw new Error(`No JSON array found in generateTrades. Raw: ${cleaned.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(match);
  } catch(e) {
    throw new Error(`JSON parse failed in generateTrades: ${e.message}`);
  }

  return normaliseAndFilterTrades(parsed, effectiveMin, { broadWeakness });
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
  const openCost       = ourTrade.executedCost / g.qty / 100;
  const maxProfitShare = (ourTrade.maxProfit || ourTrade.executedCost) / g.qty / 100;
  const currentPnL     = ourTrade.isCredit
    ? (openCost - g.currentValue) * g.qty * 100
    : (g.currentValue - openCost) * g.qty * 100;
  const currentPct     = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;
  // v3: no fixed profitTargetPnL — exit is controlled by the trailing stop
  // in monitorOpenPositions (activates at +20%, tightens at +50% and +100%).
  return { openCost, maxProfitShare, currentPnL, currentPct };
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
    // Tradier confirmed the account is genuinely flat (not a fetch failure —
    // that case returns null above). Before wiping tracked positions, apply
    // the same 60-minute grace period used by the stale-leg cleanup below.
    //
    // ROOT CAUSE OF AUG 18 2026 BUG: trades filled at 9:10 were wiped at
    // 9:20 because this branch had NO grace period. Tradier's positions
    // endpoint lags the orders endpoint by up to 15 minutes after a fill —
    // a confirmed [] response 10 minutes after placement is NOT proof the
    // trade doesn't exist. The grace period prevents this race condition by
    // refusing to purge positions placed within the last 60 minutes.
    if (state.openPositions.length > 0) {
      const nowMs       = Date.now();
      const recentTrades = state.openPositions.filter(t => {
        const ageMs = t.executedAt ? nowMs - new Date(t.executedAt).getTime() : Infinity;
        return ageMs < STALE_GRACE_MS;
      });

      if (recentTrades.length > 0) {
        // Some positions are too recent to trust a flat response — keep them.
        // Only purge trades that are clearly old enough to be genuinely gone.
        console.log(`  ⏳ Tradier shows flat but ${recentTrades.length} position(s) placed within ${STALE_GRACE_MS/60000}min — skipping cleanup (fill-to-position lag)`);
        const oldTrades = state.openPositions.filter(t => {
          const ageMs = t.executedAt ? nowMs - new Date(t.executedAt).getTime() : Infinity;
          return ageMs >= STALE_GRACE_MS;
        });
        if (oldTrades.length > 0) {
          const oldList = oldTrades.map(t => `${t.ticker} ${t.strategy}`).join(", ");
          console.error(`  🧹 STALE: ${oldList} — flat for 60min+, removing`);
          state.openPositions = state.openPositions.filter(t => !oldTrades.includes(t));
          await sendSMS(`🧹 STALE CLEANUP\n${oldList}\n\nTradier flat 60min+ since placement — assumed closed.\nVerify P&L manually.\nNot financial advice.`);
          saveState();
        }
        return [];
      }

      // No recent trades — safe to treat the flat response as authoritative.
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
  // Trades placed within STALE_GRACE_MS (module constant) are never
  // marked stale. Path 1 (account-flat in getGroupedLivePositions) now
  // uses the same constant — previously it had no grace period at all,
  // which caused the Aug 18 2026 wipe of 3 freshly-filled positions.
  const nowMs        = Date.now();
  const trulyGrouped = new Set(grouped.keys());

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

async function monitorOpenPositions(groups, underlyingPriceMap = {}) {
  if (!groups || !groups.length) return;
  console.log(`  Monitoring ${groups.length} open trade(s) (grouped by all legs)...`);

  for (const g of groups) {
    const { ourTrade } = g;
    try {
      if (!g.valid) {
        console.log(`  ⚠ ${ourTrade.ticker} ${ourTrade.strategy}: quote unavailable for one or more legs — skipping this cycle`);
        continue;
      }

      const { currentPnL, currentPct } = computePnL(ourTrade, g);

      // DTE: compare date strings as UTC midnight to avoid timezone skew.
      const todayStr = new Date().toISOString().slice(0, 10);
      const expDate  = new Date(ourTrade.expiration + "T00:00:00Z");
      const todayUTC = new Date(todayStr + "T00:00:00Z");
      const dte      = Math.ceil((expDate - todayUTC) / (1000*60*60*24));

      // Hours held — used for the 48-hour early grace period on losses.
      const hoursHeld = ourTrade.executedAt
        ? (Date.now() - new Date(ourTrade.executedAt).getTime()) / (1000 * 60 * 60)
        : 999;

      // ── HIGH-WATER MARK (trailing stop state) ────────────────────
      // ourTrade is the live reference in state.openPositions — mutating
      // it here is persisted automatically on next saveState() call.
      if (currentPct > (ourTrade.peakGainPct ?? -Infinity)) {
        ourTrade.peakGainPct = currentPct;
      }
      const peakGain = ourTrade.peakGainPct ?? currentPct;

      // ── TRAIL WIDTH based on peak gain tier ───────────────────────
      // Tightens as profit grows — at higher gains we have more to
      // protect and need less room to distinguish noise from reversal.
      const trailWidth =
        peakGain >= 100 ? MANDATE.trailWidthTier3 :
        peakGain >= 50  ? MANDATE.trailWidthTier2 :
                          MANDATE.trailWidthTier1;
      const trailActive     = peakGain >= MANDATE.trailActivationPct;
      const trailStopLevel  = peakGain - trailWidth;
      const trailBreached   = trailActive && currentPct < trailStopLevel;

      // ── DOWNSIDE STOP THRESHOLD ───────────────────────────────────
      const stopThreshold =
        hoursHeld < MANDATE.gracePeriodHours ? -MANDATE.stopLossGracePct :
        dte <= MANDATE.lateStopDTE           ? -MANDATE.stopLossLatePct  :
                                               -MANDATE.stopLossPct;

      const basisNote  = ourTrade.reconstructed ? " (basis: reconstructed — % approx)" : "";
      const trailNote  = trailActive
        ? ` | peak:+${peakGain.toFixed(1)}% trail@${trailStopLevel.toFixed(1)}%`
        : "";
      const graceRemaining = (MANDATE.gracePeriodHours - hoursHeld).toFixed(0);
      const stopNote   = hoursHeld < MANDATE.gracePeriodHours
        ? ` | stop:${stopThreshold}%(grace ${graceRemaining}h left)`
        : ` | stop:${stopThreshold}%`;
      console.log(`  ${ourTrade.ticker} ${abbrevStrategy(ourTrade.strategy)} (${g.positions.length} leg): $${g.currentValue.toFixed(2)}/sh | P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%)${basisNote}${trailNote}${stopNote} | DTE:${dte}`);

      // ── CLOSE DECISION ────────────────────────────────────────────
      let shouldClose = false, closeReason = "";
      if (dte <= MANDATE.timeDTE) {
        shouldClose = true;
        closeReason = `📅 TIME STOP — ${dte} DTE`;
      } else if (trailBreached) {
        shouldClose = true;
        closeReason = `📉 TRAILING STOP — peak +${peakGain.toFixed(1)}%, now ${currentPct.toFixed(1)}% (${trailWidth}% trail breached) = ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)}`;
      } else if (currentPct <= stopThreshold) {
        const stopContext = hoursHeld < MANDATE.gracePeriodHours
          ? `${hoursHeld.toFixed(0)}h in, catastrophic loss threshold`
          : dte <= MANDATE.lateStopDTE ? `DTE≤${MANDATE.lateStopDTE} tightened stop` : `standard stop`;
        shouldClose = true;
        closeReason = `🛑 STOP LOSS ${stopThreshold}% — ${currentPct.toFixed(1)}% (${stopContext}) = -$${Math.abs(currentPnL).toFixed(0)}`;
      }

      if (shouldClose) {
        // ── ATOMIC MULTILEG CLOSE ───────────────────────────────────
        // Previously closed each leg as an individual single-leg order
        // 500ms apart. Risk: leg 1-2 accept, leg 3-4 reject → naked short
        // left open (the exact scenario PARTIAL CLOSE ALERT was designed to
        // catch after the fact). Tradier supports multileg close orders with
        // class:"multileg" and side[i]: "buy_to_close"/"sell_to_close".
        // A single multileg order is atomic: either all legs fill or none do.
        // Single-leg positions (CSPs) still use closeOptionsPosition (single).
        let closeResult;
        if (g.positions.length === 1) {
          const pos = g.positions[0];
          closeResult = await closeOptionsPosition({ symbol:pos.symbol, underlyingSymbol:ourTrade.ticker, quantity:Math.abs(pos.quantity), side:pos.quantity>0?"buy_to_open":"sell_to_open" });
        } else {
          // Multileg: build a single close order for all legs atomically.
          // Fetch midpoint quote for limit price in live mode.
          let orderType = "market";
          let limitPrice;
          if (!TRADIER.sandbox) {
            try {
              const allSymbols = g.positions.map(p => p.symbol);
              const quotes = await getOptionQuote(allSymbols);
              const quoteMap = Object.fromEntries(quotes.map(q => [q.symbol, q]));
              // Net midpoint across all legs (same sign convention as the open)
              let netMid = 0;
              for (const pos of g.positions) {
                const q = quoteMap[pos.symbol];
                if (!q || q.bid == null || q.ask == null || q.bid <= 0) { netMid = null; break; }
                const legSign = pos.quantity > 0 ? 1 : -1; // long leg adds cost, short leg adds credit
                netMid += legSign * (q.bid + q.ask) / 2;
              }
              if (netMid != null) {
                limitPrice = Math.abs(netMid).toFixed(2);
                orderType  = "limit";
              }
            } catch(e) {
              console.log(`  ⚠ Midpoint fetch failed for multileg close — using market order`);
            }
          }
          const params = {
            class:    "multileg",
            symbol:   ourTrade.ticker,
            type:     orderType,
            duration: "day",
            ...(limitPrice ? { price: limitPrice } : {}),
          };
          g.positions.forEach((pos, i) => {
            params[`option_symbol[${i}]`] = pos.symbol;
            params[`side[${i}]`]          = pos.quantity > 0 ? "sell_to_close" : "buy_to_close";
            params[`quantity[${i}]`]       = Math.abs(pos.quantity);
          });

          let lastOrderId = null;
          let success     = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (attempt > 1 && lastOrderId && !TRADIER.sandbox) {
              try {
                const statusData  = await tradierRequest("GET", `/accounts/${TRADIER.accountId}/orders/${lastOrderId}`);
                const orderStatus = statusData?.order?.status;
                console.log(`  🔍 Multileg close ${lastOrderId} status: ${orderStatus}`);
                if (orderStatus === "filled")   { success = true; break; }
                if (["open","partially_filled","pending"].includes(orderStatus)) {
                  await new Promise(r => setTimeout(r, attempt * 5000));
                  continue;
                }
              } catch(se) {
                console.log(`  ⚠ Status check failed for ${lastOrderId}: ${se.message}`);
              }
            }
            try {
              const data    = await tradierRequest("POST", `/accounts/${TRADIER.accountId}/orders`, params);
              const orderId = data?.order?.id;
              const status  = data?.order?.status;
              if (orderId && (!status || status === "ok")) {
                lastOrderId = orderId;
                success     = true;
                console.log(`  ✅ Multileg close accepted: ${orderId} (${g.positions.length} legs)`);
                break;
              }
              if (orderId) lastOrderId = orderId;
              console.error(`  ✗ Multileg close attempt ${attempt}: ${status || "no order ID"}`);
            } catch(e) {
              console.error(`  ✗ Multileg close attempt ${attempt}: ${e.message}`);
            }
            if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 5000));
          }
          closeResult = { success };
        }
        const allClosed = closeResult.success;
        if (allClosed) {
          state.dailyPnL   += currentPnL;
          state.weeklyPnL  += currentPnL;
          state.monthlyPnL += currentPnL;
          state.openPositions = state.openPositions.filter(t => t !== ourTrade);

          // Win/loss tracking per strategy — includes exit type breakdown
          const sk = ourTrade.strategy;
          if (!state.tradeStats[sk]) state.tradeStats[sk] = { wins:0, losses:0, totalPnL:0, totalWinPnL:0, totalLossPnL:0, earlyExits:0, heldToExpiry:0 };
          const ts = state.tradeStats[sk];
          ts.totalPnL += currentPnL;
          if (currentPnL >= 0) { ts.wins++;   ts.totalWinPnL  += currentPnL; }
          else                  { ts.losses++; ts.totalLossPnL += currentPnL; }
          // Track whether the trade was closed early (profit target / stop)
          // or held to near-expiry (DTE <= minDTE) — informs whether the
          // 50% profit target is capturing value or leaving money on the table.
          if (closeReason.includes("EXPIRY RISK") || closeReason.includes("STRIKE BREACHED")) {
            ts.heldToExpiry = (ts.heldToExpiry || 0) + 1;
          } else {
            ts.earlyExits = (ts.earlyExits || 0) + 1;
          }
          // Append to persistent trade log — survives restarts, enables
          // per-ticker and per-strategy analysis that tradeStats counters alone
          // can't provide (e.g. "win rate on MRVL CSPs", "avg hold time by DTE").
          appendTradeLog({
            type:         "close",
            ticker:       ourTrade.ticker,
            strategy:     ourTrade.strategy,
            expiration:   ourTrade.expiration,
            executedCost: ourTrade.executedCost,
            collateral:   ourTrade.collateral ?? null,
            pnl:          Math.round(currentPnL),
            pnlPct:       parseFloat(currentPct.toFixed(1)),
            closeReason:  closeReason.replace(/[^\w\s%$:—.+\-]/g, "").slice(0, 80),
            dte:          dte,
            reconstructed: ourTrade.reconstructed ?? false,
            isCredit:     ourTrade.isCredit,
            legs:         g.positions.length,
            source:       ourTrade.source ?? "morning",
          });

          const winRate  = ts.wins + ts.losses > 0 ? ((ts.wins / (ts.wins + ts.losses)) * 100).toFixed(0) : "N/A";
          const avgWin   = ts.wins   > 0 ? (ts.totalWinPnL  / ts.wins).toFixed(0)   : "N/A";
          const avgLoss  = ts.losses > 0 ? (ts.totalLossPnL / ts.losses).toFixed(0) : "N/A";
          const exitNote = ts.earlyExits + ts.heldToExpiry > 0
            ? `Early exits: ${ts.earlyExits} | Held to expiry: ${ts.heldToExpiry}`
            : "";

          await sendSMS(
`◈ POSITION CLOSED
${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs)
${closeReason}

P&L: ${currentPnL>=0?"+":""}$${currentPnL.toFixed(0)} (${currentPct.toFixed(1)}%)

TODAY:   ${state.dailyPnL>=0?"+":""}$${state.dailyPnL.toFixed(0)}
WEEK:    ${state.weeklyPnL>=0?"+":""}$${state.weeklyPnL.toFixed(0)}
MONTH:   ${state.monthlyPnL>=0?"+":""}$${state.monthlyPnL.toFixed(0)}

${sk}: ${ts.wins}W/${ts.losses}L (${winRate}% win rate) | avg +$${avgWin} / -$${Math.abs(avgLoss)}
${exitNote}

Not financial advice.`
          );
        } else {
          // Close order rejected after retries — do NOT remove from tracking.
          // The position remains monitored and the close will be retried next cycle.
          const failureReason = closeResult.error || "close order rejected after retries";
          console.error(`  🚨 CLOSE FAILURE: ${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs) failed to close. Reason: ${failureReason}. Remaining tracked for retry.`);
          await sendSMS(`🚨 CLOSE FAILURE\n${ourTrade.ticker} ${ourTrade.strategy} (${g.positions.length} legs)\nReason: ${failureReason.slice(0, 200)}\nBot will retry next cycle.`);
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
  let totalUpdated   = 0;
  const targetChanges = []; // { ticker, oldTarget, newTarget, nAnalysts } — for Sunday summary
  const skipped       = []; // { ticker, newVal, oldVal, pct }             — sanity check failures

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
      return { totalUpdated, targetChanges, skipped };
    }

    // Extract JSON array — take the LAST match in case the model emitted
    // explanation text with embedded [...] before the actual data array.
    const allMatches2 = allText.match(/\[[\s\S]*?\]/g);
    const match = allMatches2 ? allMatches2[allMatches2.length - 1] : null;
    if (!match) {
      console.log("  ⚠ No JSON array found in response. Raw text:", allText.slice(0, 200));
      return { totalUpdated, targetChanges, skipped };
    }

    let results;
    try {
      results = JSON.parse(match);
    } catch(parseErr) {
      console.error("  ✗ JSON parse failed:", parseErr.message);
      return { totalUpdated, targetChanges, skipped };
    }
    for (const r of results) {
      if (!r.ticker || !r.analystTarget) continue;
      const stock        = PORTFOLIO.find(p => p.ticker === r.ticker);
      if (!stock) continue;
      const liveData     = portfolioData.find(p => p.ticker === r.ticker);
      const currentPrice = liveData?.price || r.currentPrice || stock.avgCost;
      const oldTarget    = getTarget(r.ticker, stock.target);
      const oldStop      = getStopLoss(r.ticker, stock.stopLoss);

      // SANITY CHECK: reject analyst targets that swung >50% from the previous
      // value in a single update. Confirmed: CRWD oscillated $193→$701→$195 —
      // clearly bad API data. Skip this cycle; if the API returns the same
      // value again next session it will pass (oldTarget updates to the new value).
      if (oldTarget && Math.abs(r.analystTarget - oldTarget) / oldTarget > 0.50) {
        const pct = (((r.analystTarget - oldTarget) / oldTarget) * 100).toFixed(0);
        console.warn(`  ⚠ ${r.ticker}: analyst target $${r.analystTarget} changed ${pct}% from $${oldTarget} — exceeds 50% sanity threshold, skipping (source: ${r.source || "unknown"})`);
        skipped.push({ ticker: r.ticker, newVal: r.analystTarget, oldVal: oldTarget, pct });
        continue;
      }

      const targetChanged  = Math.abs(r.analystTarget - oldTarget) / oldTarget > 0.03;
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
        if (targetChanged) {
          changes.push(`target $${oldTarget}→$${r.analystTarget} (${r.numAnalysts} analysts)`);
          targetChanges.push({ ticker: r.ticker, oldTarget, newTarget: r.analystTarget, nAnalysts: r.numAnalysts });
        }
        if (stopChanged) changes.push(`stop $${oldStop}→$${newStop}`);
        console.log(`  ✓ ${r.ticker}: ${changes.join(" | ")}`);
        totalUpdated++;
      }
    }
  } catch(e) { console.error(`  ✗ Analyst fetch failed: ${e.message}`); }

  saveState();
  console.log(`  ✅ Auto-update complete: ${totalUpdated} positions updated`);
  return { totalUpdated, targetChanges, skipped };
}

// Alias — keeps daily 9:25 AM cron working. Discards the targetChanges/skipped
// arrays since the daily refresh doesn't send a summary notification.
async function updateAnalystTargets() {
  const portfolioData = await fetchAllPrices();
  await detectAndFixSplits(portfolioData);
  await updateAllPricingLevels(portfolioData);
}


async function morningSession() {
  console.log(`\n[${new Date().toLocaleTimeString()}] 🌅 Morning session...`);
  state.dailyTrades               = [];
  state.totalDeployedToday        = 0;
  state.totalCollateralToday      = 0;
  state.dailyPnL                  = 0;
  state.dailyCircuitBreakerTripped = false; // fresh start each day

  // Reset monthly P&L on the first trading day of each month
  const today      = new Date();
  const thisMonth  = `${today.getFullYear()}-${today.getMonth()}`;
  const savedMonth = state._lastResetMonth;
  if (savedMonth !== thisMonth) {
    console.log(`  🔄 Monthly P&L reset (${state.monthlyPnL >= 0 ? "+" : ""}$${state.monthlyPnL.toFixed(0)} carried — new month starting)`);
    state.monthlyPnL      = 0;
    state._lastResetMonth = thisMonth;
  }

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

  // Circuit breaker is reset at the top of this function each morning,
  // so this guard only fires on same-day restarts after the breaker tripped.
  if (state.dailyCircuitBreakerTripped) {
    console.log("  ⏭ Daily circuit breaker tripped — no new trades this morning.");
    return;
  }

  const portfolioData = await fetchAllPrices();
  const modeFlag      = TRADIER.sandbox ? " [SANDBOX]" : "";

  // Fetch VIX for regime calibration — affects wing width and condor eligibility.
  // Fails gracefully to null if Tradier doesn't support the VIX symbol in sandbox.
  const vix = await fetchVIX();

  const spyNow    = getSpyChangeFromPortfolio(portfolioData);
  const regimeNow = getMarketRegime(spyNow, vix);
  console.log(`  📊 Regime: ${regimeNow.label} | SPY: ${spyNow.toFixed(2)}%`);

  // ── BROAD MARKET WEAKNESS DETECTION ──────────────────────────
  // SPY at 0.00% on open looks neutral but the portfolio may be screaming
  // bearish. Count tickers that have hit stop loss on consecutive days —
  // if >= broadWeaknessThreshold names are in downtrend, the market is
  // structurally weak regardless of SPY's single-day print.
  // This flag is passed to the AI prompt to favour puts over calls.
  const weakTickers = Object.entries(state.downtrendCount)
    .filter(([, dc]) => dc.count >= 1)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([t, dc]) => `${t}(${dc.count}d)`);
  const broadWeakness = weakTickers.length >= MANDATE.broadWeaknessThreshold;
  if (broadWeakness) {
    console.log(`  ⚠ BROAD WEAKNESS: ${weakTickers.length} tickers in downtrend — ${weakTickers.join(', ')} — flagging AI to favour puts`);
  }

  // Effective minimum per trade: sandbox can experiment with lower floor ($250);
  // live trading needs $600 to survive commissions and slippage.
  const effectiveMin = TRADIER.sandbox ? MANDATE.minPerTrade : MANDATE.minPerTradeLive;

  // Generate trades — retry up to 3x on network/connection errors ONLY.
  // Previously: `while (trades.length === 0)` retried even when the AI
  // legitimately returned no qualifying setups — burning 90s of delays and
  // 3 AI calls on quiet days where no trades pass the mandate filter.
  let trades = [];
  let scanAttempt = 0;
  while (scanAttempt < 3) {
    scanAttempt++;
    try {
      trades = await generateTrades(portfolioData, { spyChange: spyNow, regime: regimeNow, broadWeakness, weakTickers });
      break; // success — empty result is valid, don't retry
    } catch(e) {
      if (!isRetryableError(e) || scanAttempt === 3) {
        await sendSMS(`⚠️ Morning scan failed after ${scanAttempt} attempt(s): ${e.message}`);
        return;
      }
      const wait = scanAttempt * 30000;
      console.log(`  ⚠ Morning scan attempt ${scanAttempt} failed — retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // cachedLegs: pre-built legs can be stored here by future strategy
  // pre-selection logic. Currently unused in v3 (Long Call/Long Put
  // build legs lazily in the loop below).
  const cachedLegs = new Map();

  const executed = [];
  for (const trade of trades) {
    if (state.totalDeployedToday >= MANDATE.dailyCapMax) break;
    const stockData = portfolioData.find(p => p.ticker === trade.ticker);
    if (!stockData?.price) continue;

    // Skip tickers already in an open position — prevents doubling up if
    // morning session and opportunistic scan both recommend the same ticker.
    // Duplicate ticker guard — only one position per ticker at a time.
    if (state.openPositions.some(p => p.ticker === trade.ticker)) {
      console.log(`  ⏭  ${trade.ticker} — already have an open position on this ticker`);
      continue;
    }

    // Total position cap — count positions already open PLUS those placed this
    // session so far. The normaliseAndFilterTrades check only snapshots state
    // at filter time; this loop-level check prevents over-allocation when
    // multiple trades pass the filter and execute in the same session.
    const totalOpen = state.openPositions.length;
    if (totalOpen >= MANDATE.maxOpenPositions) {
      console.log(`  ⏭  ${trade.ticker} — max ${MANDATE.maxOpenPositions} positions reached (${totalOpen} open)`);
      break; // no point checking further trades — cap is global
    }

    const legs = cachedLegs.get(trade) || await buildOptionsLegs(trade, stockData.price, regimeNow);
    if (!legs) { console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — buildOptionsLegs returned null, skipping (see rejection reason above)`); continue; }
    if (legs.cost < effectiveMin || legs.cost > MANDATE.maxPerTrade) {
      console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — cost $${legs.cost} outside mandate range $${effectiveMin}-$${MANDATE.maxPerTrade}, skipping`);
      continue;
    }

    // Buying power gate (live only). For long options, the full cost is the
    // capital at risk — no collateral concept. legs.collateral is undefined
    // for Long Call/Put so the ?? falls back to legs.cost correctly.
    if (!TRADIER.sandbox && buyingPower > 0) {
      const capitalRequired = legs.collateral ?? legs.cost;
      const bpRemaining     = buyingPower - state.totalCollateralToday;
      if (capitalRequired > bpRemaining) {
        console.log(`  ⏭  ${trade.ticker} ${trade.strategy} — insufficient buying power ($${bpRemaining.toFixed(0)} remaining, need $${capitalRequired})`);
        continue;
      }
    }

    const result = await placeOptionsOrder({ ticker:trade.ticker, strategy:trade.strategy, legs:legs.legs, quantity:legs.quantity || 1 });
    if (result.success) {
      const ex = { ...trade, ...legs, orderId:result.orderId||"SANDBOX", executedAt:new Date().toISOString(), executedCost:legs.cost, executedPrice:stockData.price, status:"OPEN" };
      executed.push(ex);
      state.openPositions.push(ex);
      state.dailyTrades.push(ex);
      state.totalDeployedToday   += legs.cost;
      state.totalCollateralToday += (legs.collateral ?? legs.cost);
      appendTradeLog({
        type: "open", ticker: trade.ticker, strategy: trade.strategy,
        expiration: legs.expiration, executedCost: legs.cost,
        collateral: legs.collateral ?? null, executedPrice: stockData.price,
        orderId: result.orderId || "SANDBOX", source: "morning",
      });
      // Long options: "cost" not "premium/collateral" — you're buying, not selling
      const costLabel = legs.isCredit === false ? "cost" : "premium";
      console.log(`  ✅ ${trade.ticker} ${trade.strategy} — $${legs.cost} ${costLabel} | strike $${legs.strike ?? "?"} exp ${legs.expiration}`);
    } else {
      console.log(`  ✗ ${trade.ticker} ${trade.strategy} — order rejected: ${result.error}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  const regimeFlag = regimeNow.label !== "NORMAL" ? `\nRegime: ${regimeNow.label} (SPY ${spyNow.toFixed(1)}%)` : "";
  const cbFlag     = state.dailyCircuitBreakerTripped ? "\n🛑 Circuit breaker tripped — no new trades." : "";

  if (executed.length > 0) {
    // Part 1: compact header — always under 250 chars
    const header =
      `◈ MORNING${modeFlag} ${new Date().toLocaleDateString()} ✅ ${executed.length} trade${executed.length>1?"s":""}${regimeFlag}${cbFlag}\n` +
      `Spent: $${state.totalDeployedToday} | Trail activates at +${MANDATE.trailActivationPct}%\n` +
      `Monitoring every 20 min | Stop -${MANDATE.stopLossPct}% | Exit at ${MANDATE.timeDTE} DTE\nNot financial advice.`;

    // Part 2: trade detail — one compact line per trade, always fits even with 6 trades
    // Format: "1. NVDA CSP  $420 9.5%  exp 08-22  #12345"
    const tradeLines = executed.map((t, i) => {
      const strat    = abbrevStrategy(t.strategy);
      const expShort = t.expiration ? t.expiration.slice(5) : "?";   // MM-DD
      const ordShort = String(t.orderId || "?").slice(-6);            // last 6 chars
      return `${i+1}. ${t.ticker} ${strat}  $${t.executedCost} ${t.targetReturnPct}%  exp ${expShort}  #${ordShort}`;
    }).join("\n");
    const detail = `TRADES (${executed.length}):\n${tradeLines}`;

    await sendParts([header, detail]);
  } else {
    await sendSMS(
      `◈ MORNING${modeFlag} ${new Date().toLocaleDateString()}\n` +
      `No trades — no setups met the ${MANDATE.minReturnPct}% mandate.${regimeFlag}${cbFlag}\n` +
      `Not financial advice.`
    );
  }
  saveState();
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

  if (state.dailyCircuitBreakerTripped) {
    console.log("  ⏭  Skipping — daily circuit breaker tripped, no new trades today.");
    return;
  }

  const effectiveMin    = TRADIER.sandbox ? MANDATE.minPerTrade : MANDATE.minPerTradeLive;
  const budgetRemaining = MANDATE.dailyCapMax - state.totalDeployedToday;
  if (budgetRemaining < effectiveMin) {
    console.log(`  ⏭  Skipping — daily budget exhausted ($${state.totalDeployedToday} deployed, $${budgetRemaining} remaining, need ≥$${effectiveMin})`);
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
  const vix    = await fetchVIX();
  const regime = getMarketRegime(spyNow, vix);

  if (regime.skipTrading) {
    console.log(`  ⏭  Skipping — regime is ${regime.label} (${regime.note}), all trading halted`);
    return;
  }

  // Compute broad weakness from current state — same logic as morningSession.
  // downtrendCount is updated by each intradayCheck so by 11:02/1:02/3:02 PM
  // it reflects today's stop loss events accurately.
  const oppWeakTickers = Object.entries(state.downtrendCount)
    .filter(([, dc]) => dc.count >= 1)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([t, dc]) => `${t}(${dc.count}d)`);
  const oppBroadWeakness = oppWeakTickers.length >= MANDATE.broadWeaknessThreshold;

  // Generate a trade recommendation using the same AI + mandate logic
  let trades = [];
  try {
    trades = await generateTrades(portfolioData, { spyChange: spyNow, regime, broadWeakness: oppBroadWeakness, weakTickers: oppWeakTickers });
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

  // Total position cap — same rule as morningSession
  if (state.openPositions.length >= MANDATE.maxOpenPositions) {
    console.log(`  ⏭  ${candidate.ticker} — max ${MANDATE.maxOpenPositions} positions already open, skipping opportunistic entry`);
    return;
  }

  const stockData = portfolioData.find(p => p.ticker === candidate.ticker);
  const legs = await buildOptionsLegs(candidate, stockData.price, regime);
  if (!legs || legs.cost < effectiveMin || legs.cost > MANDATE.maxPerTrade || legs.cost > budgetRemaining) {
    console.log(`  ✗ ${candidate.ticker} setup did not pass final checks. Standing down.`);
    return;
  }

  const result = await placeOptionsOrder({ ticker:candidate.ticker, strategy:candidate.strategy, legs:legs.legs, quantity:legs.quantity || 1 });

  if (result.success) {
    const ex = { ...candidate, ...legs, orderId:result.orderId, executedAt:new Date().toISOString(), executedCost:legs.cost, executedPrice:stockData.price, status:"OPEN", source:"opportunistic" };
    state.openPositions.push(ex);
    state.dailyTrades.push(ex);
    state.totalDeployedToday   += legs.cost;
    state.totalCollateralToday += (legs.collateral ?? legs.cost);
    appendTradeLog({
      type: "open", ticker: candidate.ticker, strategy: candidate.strategy,
      expiration: legs.expiration, executedCost: legs.cost,
      collateral: legs.collateral ?? null, executedPrice: stockData.price,
      orderId: result.orderId, source: "opportunistic",
    });

    await sendSMS(
`🎯 OPPORTUNISTIC TRADE
${candidate.ticker} ${(stockData.changePct>=0?"▲":"▼")}${Math.abs(stockData.changePct).toFixed(1)}% move triggered scan

${candidate.strategy}
Cost: $${legs.cost} | Min return: ${candidate.targetReturnPct}%
Rationale: ${candidate.reasoning}

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
  const underlyingPriceMap = Object.fromEntries(portfolioData.map(p => [p.ticker, p]));

  // Fetch positions once and pass to both monitor and snapshot.
  const groups = await getGroupedLivePositions();
  await monitorOpenPositions(groups, underlyingPriceMap);
  saveState();

  if (state.openPositions.length > 0) {
    console.log(`  📊 Sending live snapshot for ${state.openPositions.length} open position(s)...`);
    await sendLiveSnapshot(groups);
  }

  // ── DAILY CIRCUIT BREAKER EVALUATION ─────────────────────────
  // Check combined realized + unrealized P&L against the daily max-loss
  // limit. Fires once — subsequent cycles stay quiet until reset at 9:10 AM.
  if (!state.dailyCircuitBreakerTripped) {
    const unrealizedPnL = groups
      .filter(g => g.valid && state.openPositions.includes(g.ourTrade))
      .reduce((sum, g) => sum + computePnL(g.ourTrade, g).currentPnL, 0);
    const totalExposure = state.dailyPnL + unrealizedPnL;
    if (totalExposure <= -MANDATE.dailyMaxLoss) {
      state.dailyCircuitBreakerTripped = true;
      console.error(`  🛑 CIRCUIT BREAKER: realized $${state.dailyPnL.toFixed(0)} + unrealized $${unrealizedPnL.toFixed(0)} = $${totalExposure.toFixed(0)} ≤ -$${MANDATE.dailyMaxLoss}`);
      await sendSMS(
        `🛑 DAILY CIRCUIT BREAKER TRIPPED\n` +
        `Realized P&L:   $${state.dailyPnL.toFixed(0)}\n` +
        `Unrealized P&L: $${unrealizedPnL.toFixed(0)}\n` +
        `Total:          $${totalExposure.toFixed(0)} (limit -$${MANDATE.dailyMaxLoss})\n\n` +
        `All new trading halted for today. Existing positions still monitored and auto-closed.\n` +
        `Not financial advice.`
      );
      saveState();
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  for (const stock of portfolioData) {
    if (!stock.price) continue;
    const alerts  = detectAlerts(stock);
    const urgent  = alerts.filter(a => ["STOP_LOSS","STOP_WARNING","BIG_MOVE","EARNINGS","TARGET_HIT"].includes(a.type));

    // Track consecutive STOP_LOSS days for CSP eligibility.
    // Only create state entry when first STOP_LOSS fires (sparse — don't
    // pre-populate all 17 tickers with count=0 on every cycle).
    // Decay: if no STOP_LOSS fires today, decrement count toward 0 —
    // a stock that stabilises after 3 bad days should eventually re-qualify.
    if (alerts.some(a => a.type === "TARGET_HIT")) {
      if (state.downtrendCount[stock.ticker]?.count > 0) {
        console.log(`  📈 ${stock.ticker} downtrend counter reset (TARGET_HIT after ${state.downtrendCount[stock.ticker].count} days)`);
        delete state.downtrendCount[stock.ticker];
      }
    } else if (alerts.some(a => a.type === "STOP_LOSS")) {
      if (!state.downtrendCount[stock.ticker]) {
        state.downtrendCount[stock.ticker] = { count: 0, lastDate: null };
      }
      const dc = state.downtrendCount[stock.ticker];
      if (dc.lastDate !== todayStr) {
        dc.count++;
        dc.lastDate = todayStr;
        if (dc.count >= 3) {
          console.log(`  ⚠ ${stock.ticker} downtrend: ${dc.count} consecutive STOP_LOSS days — bearish bias active if broad weakness threshold met`);
        }
      }
    } else {
      // No STOP_LOSS today — decay by 1 (once per day per ticker)
      const dc = state.downtrendCount[stock.ticker];
      if (dc && dc.count > 0 && dc.lastDate !== todayStr) {
        dc.count = Math.max(0, dc.count - 1);
        if (dc.count === 0) {
          delete state.downtrendCount[stock.ticker];
          console.log(`  📈 ${stock.ticker} downtrend counter decayed to 0 — CSP re-eligible`);
        }
      }
    }

    if (!urgent.length) continue;
    // Include date in the dedup key — without it, an alert at 3:58 PM (hour 15)
    // and again at 4:02 PM (hour 16) fire twice for the same event because the
    // hour rolls over before alertsSent.clear() runs in closingSession at 4:05.
    const key = `${todayStr}_${stock.ticker}_${urgent.map(a=>a.type).join("_")}_${new Date().getHours()}`;
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

  // ── FORCED CLOSE: DTE ≤ 1 POSITIONS ──────────────────────────
  const todayStrC = new Date().toISOString().slice(0, 10);
  const todayUTCC = new Date(todayStrC + "T00:00:00Z");
  const expiringGroups  = [];
  let   firstFetchGroups = null; // reuse below if no closes happened

  if (state.openPositions.length > 0) {
    console.log("  🔍 Checking for DTE≤1 positions to force-close before expiry...");
    firstFetchGroups = await getGroupedLivePositions();
    for (const g of firstFetchGroups) {
      if (!g.valid) continue;
      const expDate = new Date(g.ourTrade.expiration + "T00:00:00Z");
      const dte     = Math.ceil((expDate - todayUTCC) / (1000*60*60*24));
      if (dte <= MANDATE.timeDTE) {
        console.log(`  ⚠ ${g.ourTrade.ticker} ${g.ourTrade.strategy} expiring in ${dte} DTE — forcing close (time stop: ≤${MANDATE.timeDTE} DTE)`);
        expiringGroups.push(g);
      }
    }
    if (expiringGroups.length > 0) {
      const underlyingPriceMap = Object.fromEntries(portfolioData.map(p => [p.ticker, p]));
      await monitorOpenPositions(expiringGroups, underlyingPriceMap);
      console.log(`  ✅ Expiry-risk close sweep complete (${expiringGroups.length} position(s) processed).`);
      firstFetchGroups = null; // positions changed — must re-fetch for unrealized snapshot
    } else {
      console.log(`  ✓ No DTE≤${MANDATE.timeDTE} positions — nothing to force-close.`);
    }
  }

  // ── UNREALIZED P&L snapshot for summary ──────────────────────
  // Reuse firstFetchGroups when no closes happened — avoids a redundant
  // Tradier round-trip on the vast majority of days where nothing expires.
  // After closes, firstFetchGroups is nulled so we re-fetch fresh state.
  let unrealizedPnL   = 0;
  let unrealizedLines = "";
  if (state.openPositions.length > 0) {
    try {
      const remainingGroups = firstFetchGroups ?? await getGroupedLivePositions();
      const snap = getLivePositionSnapshot(remainingGroups);
      unrealizedPnL   = snap.totalPnL || 0;
      unrealizedLines = snap.lines?.length
        ? `\nOPEN POSITIONS (unrealized):\n${snap.lines.join("\n")}`
        : "";
    } catch(e) {
      console.log(`  ⚠ Could not fetch unrealized P&L for summary: ${e.message}`);
    }
  }

  // Win rate and blocked ticker data now computed inside the split-message block below.

  const totalDayPnL = state.dailyPnL + unrealizedPnL;
  const cbFlag      = state.dailyCircuitBreakerTripped ? "\n🛑 Circuit breaker tripped — new trades halted." : "";

  // Part 1: P&L numbers — always fits, always sent (~250 chars max)
  const part1 =
    `🔔 CLOSING${modeFlag} ${new Date().toLocaleDateString()}` +
    `\nTrades: ${state.dailyTrades.length} | Open: ${state.openPositions.length}` +
    `\n\nTODAY:` +
    `\nRealized:   ${state.dailyPnL  >=0?"+":""}$${state.dailyPnL.toFixed(0)}` +
    `\nUnrealized: ${unrealizedPnL   >=0?"+":""}$${unrealizedPnL.toFixed(0)}${state.openPositions.length>0?" (open positions)":""}` +
    `\nTotal:      ${totalDayPnL     >=0?"+":""}$${totalDayPnL.toFixed(0)}` +
    `\nWeek: ${state.weeklyPnL>=0?"+":""}$${state.weeklyPnL.toFixed(0)} | Month: ${state.monthlyPnL>=0?"+":""}$${state.monthlyPnL.toFixed(0)}` +
    `\nSpent today: $${state.totalDeployedToday}` +
    `${cbFlag}\nNot financial advice.`;

  // Part 2: win rates + blocked tickers + top 3 movers each side (~300 chars max)
  const blockedTickers = Object.entries(state.downtrendCount)
    .filter(([, dc]) => dc.count >= 3)
    .map(([t, dc]) => `${t}(${dc.count}d)`)
    .join(", ");

  const statsLines = Object.entries(state.tradeStats).map(([strategy, ts]) => {
    const total   = ts.wins + ts.losses;
    if (total === 0) return null;
    const winRate = ((ts.wins / total) * 100).toFixed(0);
    const strat   = abbrevStrategy(strategy);
    const avgWin  = ts.wins   > 0 ? `+$${(ts.totalWinPnL  / ts.wins  ).toFixed(0)}` : "N/A";
    const avgLoss = ts.losses > 0 ? `-$${Math.abs(ts.totalLossPnL / ts.losses).toFixed(0)}` : "N/A";
    return `${strat}: ${ts.wins}W/${ts.losses}L (${winRate}%) avg ${avgWin}/${avgLoss}`;
  }).filter(Boolean).join("\n") || "No closed trades yet";

  const top3w = winners.slice(0,3).map(p=>`${p.ticker} +${(p.changePct||0).toFixed(1)}%`).join("  ");
  const top3l = losers .slice(0,3).map(p=>`${p.ticker} ${(p.changePct||0).toFixed(1)}%`).join("  ");

  const part2 =
    `WIN RATES:\n${statsLines}` +
    (blockedTickers ? `\n\n📉 DOWNTREND (informational): ${blockedTickers}` : "") +
    `\n\n🟢 ${top3w || "None"}` +
    `\n🔴 ${top3l || "None"}`;

  // Part 3: open positions detail — only sent if positions remain after the
  // DTE≤1 close sweep above. unrealizedLines = "\nOPEN POSITIONS...\nline..."
  // trimStart() strips the leading \n; no regex needed.
  const part3 = unrealizedLines ? unrealizedLines.trimStart() : null;

  await sendParts([part1, part2, part3].filter(Boolean));
  state.alertsSent.clear();
  saveState();
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

  // Reset weekly highs at the start of each new week.
  const prevHighCount = Object.keys(state.weeklyHighs).length;
  state.weeklyHighs = {};
  console.log(`  🔄 Weekly highs reset (${prevHighCount} ticker(s) cleared — momentum filter will rebuild from today's prices)`);

  // Partial downtrend reset: clear sub-threshold counts (1-2 bad days —
  // probably a short-term dip, not a structural trend) but PRESERVE entries
  // with count >= 3 (active CSP block). A ticker hitting stop 8 consecutive
  // days doesn't deserve a clean slate just because the calendar flips to
  // Sunday. The daily decay mechanism (decrement on no-stop-loss days) is
  // the right path back to CSP eligibility for those names.
  const prevDowntrends    = Object.keys(state.downtrendCount).length;
  const activeBlocks      = Object.entries(state.downtrendCount).filter(([, dc]) => dc.count >= 3);
  const subThresholdClear = Object.entries(state.downtrendCount).filter(([, dc]) => dc.count < 3);
  for (const [ticker] of subThresholdClear) delete state.downtrendCount[ticker];
  if (prevDowntrends > 0) {
    const clearedList   = subThresholdClear.map(([t]) => t).join(", ") || "none";
    const retainedList  = activeBlocks.map(([t, dc]) => `${t}(${dc.count}d)`).join(", ") || "none";
    console.log(`  🔄 Downtrend reset: cleared sub-threshold (${clearedList}), retained active blocks (${retainedList})`);
  }

  // Capture weekly P&L before resetting
  const closingWeeklyPnL = state.weeklyPnL;
  state.weeklyPnL = 0;
  console.log(`  🔄 Weekly P&L reset (${closingWeeklyPnL >= 0 ? "+" : ""}$${closingWeeklyPnL.toFixed(0)} this week)`);

  // Check for splits FIRST — must happen before pricing update
  await detectAndFixSplits(portfolioData);
  const { totalUpdated, targetChanges, skipped } = await updateAllPricingLevels(portfolioData);

  // ── PART 1: P&L + win rates + target changes (~400 chars max) ────
  const statsLines = Object.entries(state.tradeStats).map(([strategy, ts]) => {
    const total   = ts.wins + ts.losses;
    if (total === 0) return null;
    const winRate = ((ts.wins / total) * 100).toFixed(0);
    const strat   = abbrevStrategy(strategy);
    const avgWin  = ts.wins   > 0 ? `+$${(ts.totalWinPnL   / ts.wins  ).toFixed(0)}` : "N/A";
    const avgLoss = ts.losses > 0 ? `-$${Math.abs(ts.totalLossPnL / ts.losses).toFixed(0)}` : "N/A";
    return `${strat}: ${ts.wins}W/${ts.losses}L (${winRate}%) avg ${avgWin}/${avgLoss} | net $${(ts.totalPnL||0).toFixed(0)}`;
  }).filter(Boolean).join("\n") || "No closed trades yet";

  const autoStops   = Object.values(state.dynamicLevels).filter(l => l.stopLoss).length;
  const autoTargets = Object.values(state.dynamicLevels).filter(l => l.target).length;

  // Target change lines: "✓ ARM  $430→$296 ▼▼" — compact, 2 per row when possible
  const changeLines = targetChanges.map(c => {
    const dir = c.newTarget > c.oldTarget ? "▲" : (c.newTarget < c.oldTarget * 0.9 ? "▼▼" : "▼");
    return `✓ ${c.ticker.padEnd(5)} $${c.oldTarget}→$${c.newTarget} ${dir}`;
  });
  const skipLines  = skipped.map(s => `⚠ ${s.ticker} skipped (bad data $${s.newVal} vs $${s.oldVal})`);
  const targetSection = [...changeLines, ...skipLines].join("\n") || "No target changes";

  const modeFlag = TRADIER.sandbox ? " [SANDBOX]" : "";
  const part1 =
    `📋 SUNDAY${modeFlag} ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}` +
    `\nWEEK: ${closingWeeklyPnL>=0?"+":""}$${closingWeeklyPnL.toFixed(0)} | MONTH: ${state.monthlyPnL>=0?"+":""}$${state.monthlyPnL.toFixed(0)}` +
    `\n\nWIN RATES:\n${statsLines}` +
    `\n\nAUTO-LEVELS: 🛑 stops:${autoStops} | 🎯 targets:${autoTargets}` +
    `\n\nTARGETS (${totalUpdated} updated):\n${targetSection}` +
    `\nNot financial advice.`;

  // ── PART 2: watchlist — near-stop warnings + near-target alerts + movers ──
  // Focus on names needing attention, not a full 22-ticker dump.
  // "Near stop" = within 10% of stop. "Near target" = within 10% of target.
  const nearStop = portfolioData
    .filter(p => {
      const stop = getStopLoss(p.ticker, p.stopLoss);
      return p.price && stop && ((p.price - stop) / p.price) < 0.10;
    })
    .sort((a, b) => {
      const distA = (a.price - getStopLoss(a.ticker, a.stopLoss)) / a.price;
      const distB = (b.price - getStopLoss(b.ticker, b.stopLoss)) / b.price;
      return distA - distB;
    })
    .map(p => {
      const stop = getStopLoss(p.ticker, p.stopLoss);
      const dist = (((p.price - stop) / p.price) * 100).toFixed(1);
      return `⚠ ${p.ticker} $${p.price.toFixed(0)} → stop $${stop.toFixed(0)} (${dist}% away)`;
    });

  const nearTarget = portfolioData
    .filter(p => {
      const tgt = getTarget(p.ticker, p.target);
      // Only include stocks trading BELOW their target and within 10% of it.
      // Without `p.price < tgt`, any stock above its target has a negative
      // distance which also passes the < 0.10 test — producing alerts on
      // names that have already exceeded their target, not approaching it.
      return p.price && tgt && p.price > 0 && p.price < tgt && ((tgt - p.price) / tgt) < 0.10;
    })
    .map(p => {
      const tgt  = getTarget(p.ticker, p.target);
      const dist = (((tgt - p.price) / tgt) * 100).toFixed(1);
      return `🎯 ${p.ticker} $${p.price.toFixed(0)} → target $${tgt.toFixed(0)} (${dist}% to go)`;
    });

  const winners = portfolioData.filter(p=>(p.changePct||0)>0).sort((a,b)=>b.changePct-a.changePct);
  const losers  = portfolioData.filter(p=>(p.changePct||0)<0).sort((a,b)=>a.changePct-b.changePct);

  const blockedForPart2 = Object.entries(state.downtrendCount)
    .filter(([, dc]) => dc.count >= 3)
    .map(([t, dc]) => `${t}(${dc.count}d)`).join(", ");

  const part2 =
    (nearStop.length   ? `NEAR STOP:\n${nearStop.join("\n")}\n\n` : "") +
    (nearTarget.length ? `NEAR TARGET:\n${nearTarget.join("\n")}\n\n` : "") +
    (blockedForPart2   ? `📉 DOWNTREND (informational): ${blockedForPart2}\n\n` : "") +
    // changePct is the daily move from Friday's close — markets are closed
    // Sunday morning, so this reflects Friday's last session, not the week.
    `📈 FRIDAY SESSION:\n` +
    `🟢 ${winners.slice(0,4).map(p=>`${p.ticker} +${(p.changePct||0).toFixed(1)}%`).join("  ")||"None"}\n` +
    `🔴 ${losers .slice(0,4).map(p=>`${p.ticker} ${(p.changePct||0).toFixed(1)}%`).join("  ")||"None"}`;

  await sendParts([part1, part2]);
  saveState();
  console.log("  ✅ Sunday summary sent.");
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════

const modeLabel = TRADIER.sandbox ? "SANDBOX" : "LIVE";

console.log(`\n🚀 Options Trading Bot v3 (${modeLabel} MODE)`);
console.log(`📋 Portfolio: ${PORTFOLIO.map(p=>p.ticker).join(", ")}`);
console.log(`📊 ${PORTFOLIO.length} stocks | ${PORTFOLIO.filter(p=>p.optionable).length} optionable`);
console.log(`◎  Mandate: $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day | $${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | 14-21 DTE | ${MANDATE.otmPctMin}–${MANDATE.otmPctMax}% OTM | Trail from +${MANDATE.trailActivationPct}% | Stop -${MANDATE.stopLossPct}% | ${MANDATE.timeDTE} DTE exit`);
console.log(`🔗 Tradier: ${TRADIER.baseUrl}`);
console.log("⏰ Schedule:");
console.log("   Mon–Fri 9:10 AM — Morning scan + execute");
console.log("   Mon–Fri 9:25 AM — Analyst targets refresh");
console.log("   Mon–Fri 9:30–4PM — Position monitor + trailing stops every 5 min");
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
cron.schedule("*/5 9-16 * * 1-5",  () => runExclusive("intradayCheck",        intradayCheck),        { timezone:"America/New_York" });

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

    // In live mode, send a separate loud alert first so there is no ambiguity
    // about which mode is active. A copy-pasted Railway service misconfigured
    // for live would otherwise start trading without any obvious friction.
    if (!TRADIER.sandbox) {
      await sendSMS(
        `⚠️ LIVE TRADING ACTIVE — REAL MONEY\n` +
        `Orders will execute on your real Tradier account.\n` +
        `Verify TRADIER_SANDBOX is intentionally set to false before continuing.\n` +
        `If this was unintentional, set TRADIER_SANDBOX=true and redeploy immediately.`
      );
    }

    // Compact startup summary — 22 tickers at full list would approach 1024 chars.
    // Show counts instead; full portfolio is in the Railway console log above.
    const highIVCount  = PORTFOLIO.filter(p => p.ivProfile === "high").length;
    const optionCount  = PORTFOLIO.filter(p => p.optionable).length;
    await sendSMS(
      `◈ OPTIONS BOT v3 ACTIVE (${modeLabel})\n` +
      `${optionCount} stocks (${highIVCount} high-IV) | $${MANDATE.dailyCapMin}–$${MANDATE.dailyCapMax}/day\n` +
      `$${MANDATE.minPerTrade}–$${MANDATE.maxPerTrade}/trade | ${MANDATE.minReturnPct}%+ return | ${MANDATE.otmPctMin}–${MANDATE.otmPctMax}% OTM\n` +
      `Strategy: Long Calls & Puts | Trail from +${MANDATE.trailActivationPct}% | Stop -${MANDATE.stopLossPct}%\n` +
      `9:10 execute | 5min monitor | 4PM close | Sun 8AM review\n` +
      `Open positions: ${state.openPositions.length}`
    );

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
