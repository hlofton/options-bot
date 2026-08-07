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
  profitTargetPct:   50,
  stopLossPct:       50,
  creditStopLossPct: 200,
  minPerTrade:       400,
  maxPerTrade:       1200,
  minReturnPct:      8,
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

function getMarketRegime(spyChangePct) {
  if (spyChangePct < -3.0) return { label:"EXTREME FEAR",       allowDirectional:false, allowCondors:false, allowCSP:false, skipTrading:true,  wingMultiplier:2.0,  otmPct:5 };
  if (spyChangePct > 1.0)  return { label:"STRONG RALLY",       allowDirectional:true,  allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:1.0,  otmPct:3 };
  if (spyChangePct < -1.0) return { label:"HIGH VOLATILITY",    allowDirectional:false, allowCondors:false, allowCSP:true,  skipTrading:false, wingMultiplier:1.5,  otmPct:5 };
  if (spyChangePct < -0.3) return { label:"ELEVATED VOLATILITY",allowDirectional:false, allowCondors:true,  allowCSP:true,  skipTrading:false, wingMultiplier:1.25, otmPct:4 };
  return                          { label:"NORMAL",              allowDirectional:true,  allowCondors:true,  allowCSP:true,  skipTrading:false, wingMultiplier:1.0,  otmPct:3 };
}

function detectLikelySplitRatio(storedCost, currentPrice) {
  for (const ratio of COMMON_SPLIT_RATIOS) {
    const adjustedCost = storedCost / ratio;
    const pctDiff = Math.abs(currentPrice - adjustedCost) / adjustedCost;
    if (pctDiff < 0.15) return ratio;
  }
  return null;
}

function normaliseAndFilterTrades(parsed) {
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
    if (t.targetCost < MANDATE.minPerTrade || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) return false;
    if (isDirectional(t.strategy) && HIGH_BETA_TICKERS.includes(t.ticker)) return false;
    const minScore = isDirectional(t.strategy) ? DIRECTIONAL_MIN_SCORE : INCOME_MIN_SCORE;
    if (t.setupScore < minScore) return false;
    return true;
  });
}

// ── TEST SUITES ───────────────────────────────────────────────

console.log("\n📊 getMarketRegime");

test("EXTREME FEAR: SPY -3.5%", () => {
  const r = getMarketRegime(-3.5);
  assert.equal(r.label, "EXTREME FEAR");
  assert.equal(r.skipTrading, true);
  assert.equal(r.allowCondors, false);
  assert.equal(r.allowCSP, false);
  assert.equal(typeof r.otmPct, "number", "otmPct must exist on all regimes");
});

test("HIGH VOLATILITY: SPY -1.5%", () => {
  const r = getMarketRegime(-1.5);
  assert.equal(r.label, "HIGH VOLATILITY");
  assert.equal(r.allowCondors, false);
  assert.equal(r.allowCSP, true);
  assert.equal(r.skipTrading, false);
});

test("ELEVATED VOLATILITY: SPY -0.5%", () => {
  const r = getMarketRegime(-0.5);
  assert.equal(r.label, "ELEVATED VOLATILITY");
  assert.equal(r.allowCondors, true);
  assert.equal(r.allowDirectional, false);
});

test("NORMAL: SPY flat 0%", () => {
  const r = getMarketRegime(0);
  assert.equal(r.label, "NORMAL");
  assert.equal(r.allowCondors, true);
  assert.equal(r.allowDirectional, true);
  assert.equal(r.skipTrading, false);
  assert.equal(r.otmPct, 3);
});

test("STRONG RALLY: SPY +1.5%", () => {
  const r = getMarketRegime(1.5);
  assert.equal(r.label, "STRONG RALLY");
  assert.equal(r.allowCondors, false, "condors must be blocked on strong rallies");
  assert.equal(r.allowDirectional, true, "bull spreads valid in rally");
});

test("all regimes have otmPct defined", () => {
  for (const spy of [-4, -1.5, -0.5, 0.0, 1.5]) {
    const r = getMarketRegime(spy);
    assert.ok(typeof r.otmPct === "number" && r.otmPct > 0,
      `${r.label} (SPY ${spy}%) missing otmPct`);
  }
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

test("blocks trade below minPerTrade ($400)", () => {
  const result = normaliseAndFilterTrades([makeTrade({ targetCost: 300 })]);
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
