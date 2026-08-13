// ================================================================
// OPTIONS BOT — UNIT TESTS
// ================================================================
// Tests pure computation functions that directly affect trading
// decisions. Run with: node test.mjs
//
// These functions are tested WITHOUT importing options-bot.mjs
// (which has side effects: cron scheduling, API calls, etc.).
// The functions under test are inlined here to keep tests fast
// and side-effect-free.
// ================================================================

import { strict as assert } from "assert";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ── FUNCTIONS UNDER TEST ─────────────────────────────────────
// Inlined from options-bot.mjs to avoid importing side effects.
// If you change these in options-bot.mjs, update them here too.

const MANDATE = {
  profitTargetPct:          50,
  stopLossPct:              50,
  creditStopLossPct:        200,
  singleStockCreditStopLossPct: 100,
  minPerTrade:              250,
  maxPerTrade:              1200,
  minReturnPct:             8,
  shortDTEThreshold:        4,
  cspMaxDTE:                21,
  cspMaxDTEHighIV:          14,
  cspVIXSizeMultiplier:     1.5,
};

const HIGH_BETA_TICKERS    = ["NVDA", "TSLA", "CRWD"];
const DIRECTIONAL_MIN_SCORE = 8;
const INCOME_MIN_SCORE      = 6;
const COMMON_SPLIT_RATIOS   = [2, 3, 4, 5, 10];

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

function getVIXLabel(vix) {
  if (!vix)     return { label:"UNKNOWN",  note:"VIX unavailable" };
  if (vix > 40) return { label:"CRASH",    note:`VIX ${vix.toFixed(1)} — crash-level fear, all trading halted` };
  if (vix > 30) return { label:"EXTREME",  note:`VIX ${vix.toFixed(1)} — extreme fear, gap risk high` };
  if (vix > 20) return { label:"ELEVATED", note:`VIX ${vix.toFixed(1)} — elevated IV, wider wings collect more premium` };
  if (vix > 15) return { label:"NORMAL",   note:`VIX ${vix.toFixed(1)} — normal conditions` };
  return         { label:"LOW",      note:`VIX ${vix.toFixed(1)} — compressed premium, be selective on condors` };
}

function getMarketRegime(spyChangePct, vix = null) {
  const vixInfo = getVIXLabel(vix);
  if (spyChangePct < -5.0) return { label:"MARKET CRASH",       allowDirectional:false, allowCondors:false, allowCSP:false, skipTrading:true,  wingMultiplier:2.0,  otmPct:7, vix:vixInfo };
  if (spyChangePct < -3.0) return { label:"EXTREME FEAR",       allowDirectional:false, allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:2.0,  otmPct:7, vix:vixInfo };
  if (vix && vix > 40)     return { label:"MARKET CRASH",       allowDirectional:false, allowCondors:false, allowCSP:false, skipTrading:true,  wingMultiplier:2.0,  otmPct:7, vix:vixInfo };
  if (vix && vix > 30)     return { label:"EXTREME FEAR",       allowDirectional:false, allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:2.0,  otmPct:7, vix:vixInfo };
  if (spyChangePct > 1.0)  return { label:"STRONG RALLY",       allowDirectional:false, allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:1.0,  otmPct:3, vix:vixInfo };
  if (spyChangePct < -1.0) return { label:"HIGH VOLATILITY",    allowDirectional:false, allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:1.5,  otmPct:5, vix:vixInfo };
  if (spyChangePct < -0.7) return { label:"ELEVATED VOLATILITY",allowDirectional:false, allowCondors:true,  allowCSP:true,  skipTrading:false, wingMultiplier:1.25, otmPct:4, vix:vixInfo };
  return                          { label:"NORMAL",              allowDirectional:false, allowCondors:true,  allowCSP:true,  skipTrading:false, wingMultiplier:1.0,  otmPct:3, vix:vixInfo };
}

function detectLikelySplitRatio(storedCost, currentPrice) {
  for (const ratio of COMMON_SPLIT_RATIOS) {
    const adjustedCost = storedCost / ratio;
    const pctDiff = Math.abs(currentPrice - adjustedCost) / adjustedCost;
    if (pctDiff < 0.15) return ratio;
  }
  return null;
}

function normaliseAndFilterTrades(parsed, effectiveMin = MANDATE.minPerTrade, downtrendCount = {}) {
  const isDirectional = s => ["Bull Call Spread", "Bear Put Spread"].includes(s);
  const normalised = parsed.map(t => ({
    ...t,
    targetCost:      t.targetCost      ?? t.cost      ?? 0,
    targetReturnPct: t.targetReturnPct ?? t.returnPct ?? "0",
    setupScore:      t.setupScore      ?? t.score     ?? 0,
    strategy:        t.strategy        ?? t.type      ?? "Unknown",
    direction:       t.direction       ?? "NEUTRAL",
    rationale:       t.rationale       ?? "",
    exitTarget:      t.exitTarget      ?? "",
  }));
  return normalised.filter(t => {
    if (t.targetCost < effectiveMin || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) return false;
    if (t.strategy === "Cash Secured Put") {
      const dtCount = downtrendCount[t.ticker]?.count || 0;
      if (dtCount >= 3) return false;
    }
    if (isDirectional(t.strategy) && HIGH_BETA_TICKERS.includes(t.ticker)) return false;
    const minScore = isDirectional(t.strategy) ? DIRECTIONAL_MIN_SCORE : INCOME_MIN_SCORE;
    if (t.setupScore < minScore) return false;
    return true;
  });
}

// ── TEST SUITES ───────────────────────────────────────────────

console.log("\n📊 getMarketRegime");

test("MARKET CRASH: SPY -5.5% — all trading halted", () => {
  const r = getMarketRegime(-5.5);
  assert.equal(r.label, "MARKET CRASH");
  assert.equal(r.skipTrading, true);
  assert.equal(r.allowCSP, false, "even CSPs halted in crash");
  assert.equal(typeof r.otmPct, "number", "otmPct must exist on all regimes");
});

test("EXTREME FEAR: SPY -3.5% — CSP allowed, condors not", () => {
  const r = getMarketRegime(-3.5);
  assert.equal(r.label, "EXTREME FEAR");
  assert.equal(r.skipTrading, false, "CSPs valid in extreme fear — fat premium");
  assert.equal(r.allowCSP, true);
  assert.equal(r.allowCondors, false);
  assert.equal(typeof r.otmPct, "number", "otmPct must exist on all regimes");
});

test("MARKET CRASH: VIX > 40 regardless of SPY", () => {
  const r = getMarketRegime(0.5, 42);
  assert.equal(r.label, "MARKET CRASH");
  assert.equal(r.skipTrading, true);
});

test("EXTREME FEAR: VIX 31-40 — CSP allowed", () => {
  const r = getMarketRegime(0.0, 35);
  assert.equal(r.label, "EXTREME FEAR");
  assert.equal(r.allowCSP, true);
  assert.equal(r.skipTrading, false);
});

test("HIGH VOLATILITY: SPY -1.5%", () => {
  const r = getMarketRegime(-1.5);
  assert.equal(r.label, "HIGH VOLATILITY");
  assert.equal(r.allowCondors, false);
  assert.equal(r.allowCSP, true);
  assert.equal(r.skipTrading, false);
});

test("ELEVATED VOLATILITY: SPY -0.8%", () => {
  const r = getMarketRegime(-0.8);
  assert.equal(r.label, "ELEVATED VOLATILITY");
  assert.equal(r.allowCondors, true);
  assert.equal(r.allowDirectional, false);
});

test("NORMAL: SPY flat 0%", () => {
  const r = getMarketRegime(0);
  assert.equal(r.label, "NORMAL");
  assert.equal(r.allowCondors, true);
  assert.equal(r.allowDirectional, false);
  assert.equal(r.skipTrading, false);
  assert.equal(r.otmPct, 3);
});

test("STRONG RALLY: SPY +1.5%", () => {
  const r = getMarketRegime(1.5);
  assert.equal(r.label, "STRONG RALLY");
  assert.equal(r.allowCondors, false, "condors must be blocked on strong rallies");
  assert.equal(r.allowDirectional, false, "directional spreads retired Aug 2026");
});

test("all regimes have otmPct defined", () => {
  for (const spy of [-6, -4, -1.5, -0.8, 0.0, 1.5]) {
    const r = getMarketRegime(spy);
    assert.ok(typeof r.otmPct === "number" && r.otmPct > 0,
      `${r.label} (SPY ${spy}%) missing otmPct`);
  }
});

test("boundary: -0.71% is ELEVATED, -0.70% is NORMAL (strict less-than)", () => {
  assert.equal(getMarketRegime(-0.71).label, "ELEVATED VOLATILITY");
  assert.equal(getMarketRegime(-0.70).label, "NORMAL");
});

test("boundary: exactly -1.0% is ELEVATED not HIGH", () => {
  const r = getMarketRegime(-1.0);
  assert.equal(r.label, "ELEVATED VOLATILITY");
});

test("boundary: exactly +1.0% is NORMAL not STRONG RALLY", () => {
  const r = getMarketRegime(1.0);
  assert.equal(r.label, "NORMAL");
});

console.log("\n💰 computePnL");

test("debit spread: profit when value rises above cost", () => {
  const trade = { executedCost: 428, maxProfit: 572, isCredit: false };
  const g     = { qty: 1, currentValue: 6.00 };
  // openCost = 428/1/100 = $4.28/sh; value rose to $6.00 → profit
  const { currentPnL } = computePnL(trade, g);
  assert.equal(Math.round(currentPnL), 172);
  assert.ok(currentPnL > 0);
});

test("debit spread: loss when value falls below cost", () => {
  const trade = { executedCost: 428, maxProfit: 572, isCredit: false };
  const g     = { qty: 1, currentValue: 2.00 };
  const { currentPnL } = computePnL(trade, g);
  assert.equal(Math.round(currentPnL), -228);
  assert.ok(currentPnL < 0);
});

test("debit spread: exactly at 50% stop loss threshold", () => {
  const trade = { executedCost: 428, maxProfit: 572, isCredit: false };
  const g     = { qty: 1, currentValue: 2.14 }; // (2.14 - 4.28) * 100 = -214 = -50%
  const { currentPnL } = computePnL(trade, g);
  const stopThreshold  = -(428 * (MANDATE.stopLossPct / 100));
  assert.ok(currentPnL <= stopThreshold,
    `P&L ${currentPnL.toFixed(0)} should be at or below stop ${stopThreshold}`);
});

test("credit spread: profit when value decays", () => {
  const trade = { executedCost: 420, maxProfit: 420, isCredit: true };
  const g     = { qty: 1, currentValue: 1.50 };
  // credit P&L = (4.20 - 1.50) * 100 = 270
  const { currentPnL } = computePnL(trade, g);
  assert.equal(Math.round(currentPnL), 270);
  assert.ok(currentPnL > 0);
});

test("credit spread: loss when value expands past entry", () => {
  const trade = { executedCost: 420, maxProfit: 420, isCredit: true };
  const g     = { qty: 1, currentValue: 6.00 };
  const { currentPnL } = computePnL(trade, g);
  assert.ok(currentPnL < 0);
});

test("profit target is exactly 50% of maxProfit", () => {
  const trade = { executedCost: 420, maxProfit: 420, isCredit: true };
  const g     = { qty: 1, currentValue: 2.10 }; // at exactly 50% profit
  const { profitTargetPnL, currentPnL } = computePnL(trade, g);
  assert.equal(Math.round(profitTargetPnL), 210);
  assert.ok(Math.abs(currentPnL - profitTargetPnL) < 1,
    "at target value, P&L should equal profitTargetPnL");
});

test("multi-contract Iron Condor: qty scaling is correct", () => {
  // 12 contracts, credit $408 total
  const trade = { executedCost: 408, maxProfit: 408, isCredit: true };
  const g     = { qty: 12, currentValue: 0.05 }; // nearly fully decayed
  const { currentPnL, profitTargetPnL } = computePnL(trade, g);
  // openCost = 408/12/100 = $0.34/sh
  // credit P&L = (0.34 - 0.05) * 12 * 100 = 348
  assert.equal(Math.round(currentPnL), 348);
  // profitTarget = 0.34 * 12 * 100 * 0.50 = 204
  assert.equal(Math.round(profitTargetPnL), 204);
  assert.ok(currentPnL > profitTargetPnL, "at near-zero value, should exceed profit target");
});

test("currentPct is positive when trade is profitable", () => {
  const trade = { executedCost: 428, maxProfit: 572, isCredit: false };
  const g     = { qty: 1, currentValue: 6.00 };
  const { currentPct } = computePnL(trade, g);
  assert.ok(currentPct > 0);
});

console.log("\n🔀 detectLikelySplitRatio");

test("detects 4-for-1 split: $800 → $200", () => {
  assert.equal(detectLikelySplitRatio(800, 200), 4);
});

test("detects 2-for-1 split: $200 → $100", () => {
  assert.equal(detectLikelySplitRatio(200, 100), 2);
});

test("detects 5-for-1 split: $500 → $100", () => {
  assert.equal(detectLikelySplitRatio(500, 100), 5);
});

test("returns null when drop is not a clean ratio", () => {
  assert.equal(detectLikelySplitRatio(200, 130), null); // ~35% drop, not a split
});

test("tolerates up to 15% price variation around ratio", () => {
  // $400 split 2-for-1 → expected $200, actual $215 (7.5% variation)
  assert.equal(detectLikelySplitRatio(400, 215), 2);
});

test("returns null when just below 15% tolerance", () => {
  // $400 / 2 = $200; $200 * 1.17 = $234 — 17% off, should fail
  assert.equal(detectLikelySplitRatio(400, 234), null);
});

console.log("\n🎯 normaliseAndFilterTrades");

const makeTrade = (overrides) => ({
  ticker: "MSFT", strategy: "Bull Call Spread", direction: "BULLISH",
  targetCost: 800, targetReturnPct: "10.0", setupScore: 8,
  rationale: "test", exitTarget: "50% profit",
  ...overrides,
});

test("passes a valid directional trade", () => {
  const result = normaliseAndFilterTrades([makeTrade()]);
  assert.equal(result.length, 1);
});

test("blocks trade below minPerTrade ($250)", () => {
  const result = normaliseAndFilterTrades([makeTrade({ targetCost: 200 })]);
  assert.equal(result.length, 0);
});

test("blocks trade above maxPerTrade ($1200)", () => {
  const result = normaliseAndFilterTrades([makeTrade({ targetCost: 1300 })]);
  assert.equal(result.length, 0);
});

test("blocks directional trade with setupScore < 8", () => {
  const result = normaliseAndFilterTrades([makeTrade({ setupScore: 7 })]);
  assert.equal(result.length, 0);
});

test("allows income trade with setupScore >= 6", () => {
  const result = normaliseAndFilterTrades([makeTrade({ strategy: "Iron Condor", setupScore: 6 })]);
  assert.equal(result.length, 1);
});

test("blocks income trade with setupScore < 6", () => {
  const result = normaliseAndFilterTrades([makeTrade({ strategy: "Iron Condor", setupScore: 5 })]);
  assert.equal(result.length, 0);
});

test("blocks Bull Call Spread on high-beta ticker (NVDA)", () => {
  const result = normaliseAndFilterTrades([makeTrade({ ticker: "NVDA", strategy: "Bull Call Spread" })]);
  assert.equal(result.length, 0);
});

test("allows Iron Condor on high-beta ticker (NVDA)", () => {
  const result = normaliseAndFilterTrades([makeTrade({ ticker: "NVDA", strategy: "Iron Condor", setupScore: 7 })]);
  assert.equal(result.length, 1);
});

test("normalises alternate field names (cost → targetCost)", () => {
  const raw = [{ ticker:"AAPL", strategy:"Iron Condor", direction:"NEUTRAL",
    cost:600, returnPct:"9.0", score:7, rationale:"test", exitTarget:"50%" }];
  const result = normaliseAndFilterTrades(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].targetCost, 600);
});

test("blocks trade with return below 8%", () => {
  const result = normaliseAndFilterTrades([makeTrade({ targetReturnPct: "7.5" })]);
  assert.equal(result.length, 0);
});

test("passes multiple valid trades, blocks one invalid", () => {
  const trades = [
    makeTrade({ ticker: "MSFT" }),                          // valid
    makeTrade({ ticker: "AAPL", strategy: "Iron Condor", setupScore: 7 }), // valid
    makeTrade({ ticker: "NVDA", strategy: "Bull Call Spread" }),            // blocked: high-beta
  ];
  const result = normaliseAndFilterTrades(trades);
  assert.equal(result.length, 2);
});


console.log("\n🌡️ getVIXLabel");

test("VIX > 40 returns CRASH label (not EXTREME)", () => {
  const r = getVIXLabel(42);
  assert.equal(r.label, "CRASH", "VIX>40 must be CRASH — different trading rule from EXTREME");
});

test("VIX 31-40 returns EXTREME label", () => {
  assert.equal(getVIXLabel(35).label, "EXTREME");
});

test("VIX 14 returns LOW label (condors skipped)", () => {
  assert.equal(getVIXLabel(14).label, "LOW");
});

test("null VIX returns UNKNOWN", () => {
  assert.equal(getVIXLabel(null).label, "UNKNOWN");
});

console.log("\n📐 pre-breach distance calculation");

function pctToStrike(livePrice, strike) {
  return Math.abs(livePrice - strike) / livePrice;
}

test("1.9% from short call triggers pre-breach (< 2% threshold)", () => {
  const shortCall = 780;
  const live      = 780 * (1 - 0.019);
  assert.ok(pctToStrike(live, shortCall) < 0.02);
});

test("2.1% from short call does NOT trigger pre-breach", () => {
  const shortCall = 780;
  const live      = 780 * (1 - 0.021);
  assert.ok(pctToStrike(live, shortCall) >= 0.02);
});

test("1.9% above short put triggers pre-breach", () => {
  const shortPut = 700;
  const live     = 700 * (1 + 0.019);
  assert.ok(pctToStrike(live, shortPut) < 0.02);
});

console.log("\n💸 short-DTE and index credit stop thresholds");

test("50% credit stop for single-stock IC with DTE <= 4", () => {
  const credit = 423;
  assert.equal(Math.round(-(credit * 0.50)), -211);
});

test("100% credit stop for single-stock IC with DTE > 4", () => {
  const credit = 423;
  assert.equal(Math.round(-(credit * 1.00)), -423);
});

test("200% credit stop for index IC (any DTE)", () => {
  const credit = 408;
  assert.equal(Math.round(-(credit * 2.00)), -816);
});

console.log("\n📉 downtrend CSP filter");

const makeCsp = (ticker, overrides = {}) => ({
  ticker, strategy: "Cash Secured Put", direction: "NEUTRAL",
  targetCost: 400, targetReturnPct: "10.0", setupScore: 7,
  rationale: "test", exitTarget: "50% profit", ...overrides,
});

test("CSP allowed when downtrend count < 3", () => {
  const r = normaliseAndFilterTrades([makeCsp("MSFT")], MANDATE.minPerTrade, { MSFT: { count: 2 } });
  assert.equal(r.length, 1, "count=2 should still allow CSP");
});

test("CSP blocked when downtrend count >= 3", () => {
  const r = normaliseAndFilterTrades([makeCsp("AMD")], MANDATE.minPerTrade, { AMD: { count: 3 } });
  assert.equal(r.length, 0, "3 consecutive STOP_LOSS days should block CSP");
});

test("CSP allowed with no downtrend data", () => {
  const r = normaliseAndFilterTrades([makeCsp("AMD")], MANDATE.minPerTrade, {});
  assert.equal(r.length, 1);
});

test("downtrend block is per-ticker — other tickers unaffected", () => {
  const trades = [makeCsp("AMD"), makeCsp("MSFT")];
  const r = normaliseAndFilterTrades(trades, MANDATE.minPerTrade, { AMD: { count: 4 } });
  assert.equal(r.length, 1);
  assert.equal(r[0].ticker, "MSFT");
});

console.log("\n🌡️ VIX-aware CSP sizing logic");

test("CSP size multiplier is 1.5x when VIX ELEVATED", () => {
  // Credit $200/contract, target $250 * 1.5 = $375 effective min
  // qty = round(375 / 200) = 2 contracts, credit = $400
  const creditPerContract = 200;
  const sizeMulti = MANDATE.cspVIXSizeMultiplier;
  const qty = Math.max(1, Math.round((MANDATE.minPerTrade * sizeMulti) / creditPerContract));
  assert.equal(qty, 2, "should size up to 2 contracts in elevated VIX");
  assert.ok(creditPerContract * qty <= MANDATE.maxPerTrade, "sized credit must stay under maxPerTrade");
});

test("CSP size multiplier 1x in NORMAL regime", () => {
  const creditPerContract = 200;
  const sizeMulti = 1.0; // NORMAL
  const qty = Math.max(1, Math.round((MANDATE.minPerTrade * sizeMulti) / creditPerContract));
  assert.equal(qty, 1, "normal regime should place 1 contract");
});

test("cspMaxDTEHighIV is strictly less than cspMaxDTE", () => {
  assert.ok(MANDATE.cspMaxDTEHighIV < MANDATE.cspMaxDTE,
    "high-IV names should use shorter DTE window than medium-IV");
});

console.log("\n📉 downtrend decay and reset");

test("downtrendCount decays toward 0 when no STOP_LOSS", () => {
  // Simulate: count=3 ticker, no stop today → count becomes 2
  const dc = { count: 3, lastDate: "2026-08-12" };
  const todayStr = "2026-08-13";
  if (dc.lastDate !== todayStr) {
    dc.count = Math.max(0, dc.count - 1);
  }
  assert.equal(dc.count, 2, "count should decay by 1 when no stop fires");
});

test("downtrendCount does not decay twice on same day", () => {
  const dc = { count: 3, lastDate: "2026-08-13" };
  const todayStr = "2026-08-13"; // same day
  if (dc.lastDate !== todayStr) {
    dc.count = Math.max(0, dc.count - 1);
  }
  assert.equal(dc.count, 3, "should not decay when lastDate matches today");
});

test("downtrendCount clamps at 0", () => {
  const dc = { count: 1, lastDate: "2026-08-12" };
  const todayStr = "2026-08-13";
  if (dc.lastDate !== todayStr) {
    dc.count = Math.max(0, dc.count - 1);
  }
  assert.equal(dc.count, 0, "count should not go below 0");
});

// ── RESULTS ───────────────────────────────────────────────────
const total = passed + failed;

console.log(`\n${"─".repeat(50)}`);
console.log(`${total} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed.`);
}
