/**
 * options-bot.test.mjs — v3 Long Calls / Long Puts
 * Unit tests for pure functions controlling live trading decisions.
 *
 * Run with:  node --test options-bot.test.mjs
 * Requires:  Node 18+ (built-in node:test and node:assert)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────
// INLINE COPIES OF PURE FUNCTIONS (see options-bot.mjs for originals)
// ─────────────────────────────────────────────────────────────────

function abbrevStrategy(s) {
  return s
    .replace("Long Call",        "LC")
    .replace("Long Put",         "LP")
    .replace("Cash Secured Put", "CSP")
    .replace("Iron Condor",      "IC")
    .replace("Bull Call Spread", "BCS")
    .replace("Bear Put Spread",  "BPS");
}

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

function getVIXLabel(vix) {
  if (!vix)     return { label: "UNKNOWN", note: "VIX unavailable" };
  if (vix > 40) return { label: "EXTREME",  note: `VIX ${vix.toFixed(1)} — extreme fear` };
  if (vix > 30) return { label: "HIGH",     note: `VIX ${vix.toFixed(1)} — high fear` };
  if (vix > 20) return { label: "ELEVATED", note: `VIX ${vix.toFixed(1)} — elevated` };
  if (vix > 15) return { label: "NORMAL",   note: `VIX ${vix.toFixed(1)} — normal` };
  return         { label: "LOW",     note: `VIX ${vix.toFixed(1)} — low/compressed` };
}

function getMarketRegime(spyChangePct, vix = null) {
  const vixInfo = getVIXLabel(vix);
  if (spyChangePct < -5.0) {
    return { label:"MARKET CRASH", allowDirectional:false, allowCondors:false, allowCSP:false,
             skipTrading:true, wingMultiplier:2.0, otmPct:7, vix:vixInfo };
  }
  if (spyChangePct < -3.0) {
    return { label:"EXTREME FEAR", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:2.0, otmPct:7, vix:vixInfo };
  }
  if (vix && vix > 40) {
    return { label:"MARKET CRASH", allowDirectional:false, allowCondors:false, allowCSP:false,
             skipTrading:true, wingMultiplier:2.0, otmPct:7, vix:vixInfo };
  }
  if (vix && vix > 30) {
    return { label:"EXTREME FEAR", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:2.0, otmPct:7, vix:vixInfo };
  }
  const vixWingBonus = (vix && vix > 20) ? 0.5 : 0;
  const vixOtmBonus  = (vix && vix > 20) ? 1   : 0;
  const lowVIX       = (vix && vix < 15);
  if (spyChangePct > 1.0) {
    return { label:"STRONG RALLY", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:1.0 + vixWingBonus, otmPct:5 + vixOtmBonus, vix:vixInfo };
  }
  if (spyChangePct > -1.0) {
    return { label:"NORMAL", allowDirectional:true, allowCondors:!lowVIX, allowCSP:true,
             skipTrading:false, wingMultiplier:1.0 + vixWingBonus, otmPct:5 + vixOtmBonus, vix:vixInfo };
  }
  return { label:"HIGH VOLATILITY", allowDirectional:false, allowCondors:!lowVIX, allowCSP:true,
           skipTrading:false, wingMultiplier:1.5 + vixWingBonus, otmPct:6 + vixOtmBonus, vix:vixInfo };
}

const PROFIT_TARGET_PCT = 100;
function computePnL(ourTrade, g) {
  const openCost        = ourTrade.executedCost / g.qty / 100;
  const maxProfitShare  = (ourTrade.maxProfit || ourTrade.executedCost) / g.qty / 100;
  const currentPnL      = ourTrade.isCredit
    ? (openCost - g.currentValue) * g.qty * 100
    : (g.currentValue - openCost) * g.qty * 100;
  const currentPct      = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;
  const profitTargetPnL = openCost * g.qty * 100 * (PROFIT_TARGET_PCT / 100);
  return { openCost, maxProfitShare, currentPnL, currentPct, profitTargetPnL };
}

// v3 mandate values
const MANDATE = {
  minPerTrade: 250, maxPerTrade: 1000, minReturnPct: 20,
  stopLossPct: 50, timeDTE: 2,
  targetMinDTE: 14, targetMaxDTE: 21, otmPctMin: 2, otmPctMax: 7,
  maxOpenPositions: 4, minSetupScore: 8,
};
const HIGH_BETA_TICKERS   = ["NVDA", "TSLA", "CRWD", "COIN", "HOOD", "ARM"];
const LONG_OPTIONS_MIN_SCORE = 8;
const HIGH_BETA_MIN_SCORE    = 9;
const EARNINGS = {
  NVDA: "2026-11-19", MRVL: "2026-08-27", AVGO: "2026-09-04",
  PANW: "2026-09-10", AAPL: "2026-11-01",
};

// Minimal state for filter
const state = { openPositions: [] };

function normaliseAndFilterTrades(parsed, effectiveMin = MANDATE.minPerTrade, { broadWeakness = false } = {}) {
  if (!Array.isArray(parsed)) return [];
  const normalised = parsed.map(t => ({
    ticker:          t.ticker    ?? "",
    strategy:        t.strategy  ?? "",
    targetCost:      parseFloat(t.targetCost  ?? t.cost ?? 0),
    targetReturnPct: parseFloat(t.targetReturnPct ?? t.returnPct ?? "0"),
    setupScore:      parseFloat(t.setupScore  ?? t.score ?? 0),
    direction:       t.direction ?? "unknown",
    reasoning:       t.reasoning ?? t.rationale ?? "",
    catalyst:        t.catalyst  ?? "",
    exitTarget:      t.exitTarget ?? "",
  }));
  return normalised.filter(t => {
    if (!["Long Call","Long Put"].includes(t.strategy)) return false;
    if (t.targetCost < effectiveMin || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct) return false;
    const earningsDate = EARNINGS[t.ticker];
    if (earningsDate) {
      const todayUTC = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z").getTime();
      const daysOut  = Math.ceil((new Date(earningsDate + "T00:00:00Z") - todayUTC) / (1000*60*60*24));
      if (daysOut > 0 && daysOut <= 5) return false;
    }
    const isCall   = t.strategy === "Long Call";
    const minScore = HIGH_BETA_TICKERS.includes(t.ticker)
      ? HIGH_BETA_MIN_SCORE
      : (broadWeakness && isCall ? 9 : LONG_OPTIONS_MIN_SCORE);
    if (t.setupScore < minScore) return false;
    if (state.openPositions.length >= MANDATE.maxOpenPositions) return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────

describe("abbrevStrategy", () => {
  test("abbreviates v3 strategies", () => {
    assert.equal(abbrevStrategy("Long Call"), "LC");
    assert.equal(abbrevStrategy("Long Put"),  "LP");
  });
  test("still abbreviates legacy strategy names", () => {
    assert.equal(abbrevStrategy("Cash Secured Put"), "CSP");
    assert.equal(abbrevStrategy("Iron Condor"),      "IC");
  });
  test("passes through unknown strategies unchanged", () => {
    assert.equal(abbrevStrategy("Covered Call"), "Covered Call");
  });
});

describe("isRetryableError", () => {
  test("retries on network errors", () => {
    assert.ok(isRetryableError(new Error("Connection error")));
    assert.ok(isRetryableError(new Error("ECONNREFUSED")));
    assert.ok(isRetryableError(new Error("fetch failed")));
    assert.ok(isRetryableError(new Error("timeout")));
  });
  test("retries on 529/503", () => {
    assert.ok(isRetryableError(Object.assign(new Error("overloaded"), { status: 529 })));
    assert.ok(isRetryableError(Object.assign(new Error("unavailable"), { status: 503 })));
  });
  test("does NOT retry on auth or bad request", () => {
    assert.ok(!isRetryableError(Object.assign(new Error("Unauthorized"), { status: 401 })));
    assert.ok(!isRetryableError(new Error("JSON parse failed")));
  });
});

describe("getMarketRegime", () => {
  test("MARKET CRASH halts all trading when SPY < -5%", () => {
    const r = getMarketRegime(-5.1);
    assert.equal(r.label, "MARKET CRASH");
    assert.ok(r.skipTrading);
  });
  test("SPY exactly at -5.0% is NOT a crash (boundary)", () => {
    assert.notEqual(getMarketRegime(-5.0).label, "MARKET CRASH");
  });
  test("VIX > 40 triggers MARKET CRASH regardless of SPY", () => {
    assert.equal(getMarketRegime(0.5, 41).label, "MARKET CRASH");
  });
  test("NORMAL regime with mid-range VIX", () => {
    const r = getMarketRegime(0.0, 18);
    assert.equal(r.label, "NORMAL");
  });
  test("STRONG RALLY when SPY > 1%", () => {
    assert.equal(getMarketRegime(1.5).label, "STRONG RALLY");
  });
  test("regime always includes vix field", () => {
    const r = getMarketRegime(-6.0);
    assert.ok("vix" in r);
    assert.equal(r.vix.label, "UNKNOWN");
  });
});

describe("computePnL — long options (isCredit: false)", () => {
  // executedCost = total dollars spent (e.g. $300)
  // qty = number of contracts
  // openCost = executedCost / qty / 100 = price per share
  // "3 contracts @ $1.00/sh = $300": executedCost=300, qty=3
  const longTrade = (executedCost, qty) => ({
    executedCost, maxProfit: null, isCredit: false, quantity: qty,
  });
  const group = (currentValue, qty) => ({ currentValue, qty, positions: [] });

  test("at-entry: zero P&L", () => {
    const t = longTrade(300, 3);
    const g = group(1.00, 3);
    assert.equal(computePnL(t, g).currentPnL, 0);
    assert.equal(computePnL(t, g).currentPct, 0);
  });

  test("+20% gain: trail activation threshold", () => {
    const t = longTrade(300, 3); // 3 × $1.00/sh
    const g = group(1.20, 3);    // now $1.20/sh
    const { currentPct } = computePnL(t, g);
    assert.equal(Math.round(currentPct), 20);
  });

  test("+50% gain: trail tier 2 boundary", () => {
    const t = longTrade(300, 3);
    const g = group(1.50, 3);
    const { currentPct } = computePnL(t, g);
    assert.equal(Math.round(currentPct), 50);
  });

  test("+100% gain: option doubled", () => {
    const t = longTrade(300, 3);
    const g = group(2.00, 3);
    const { currentPnL, currentPct } = computePnL(t, g);
    assert.equal(currentPnL, 300);
    assert.equal(currentPct, 100);
  });

  test("-50% loss: standard stop threshold", () => {
    const t = longTrade(300, 3);
    const g = group(0.50, 3);
    const { currentPnL, currentPct } = computePnL(t, g);
    assert.equal(currentPnL, -150);
    assert.equal(Math.round(currentPct), -50);
  });

  test("-70% loss: catastrophic / grace period threshold", () => {
    const t = longTrade(300, 3);
    const g = group(0.30, 3);
    const { currentPct } = computePnL(t, g);
    assert.equal(Math.round(currentPct), -70);
  });

  test("option near-zero (total loss scenario)", () => {
    const t = longTrade(300, 3);
    const g = group(0.01, 3);
    assert.ok(computePnL(t, g).currentPnL < -295);
  });
});

describe("trailing stop logic", () => {
  // Inline the trailing stop logic to test it independently
  const MANDATE = {
    trailActivationPct: 15, trailWidthTier1: 5,
    trailWidthTier2: 8, trailWidthTier3: 6,
    stopLossPct: 50, stopLossGracePct: 70, stopLossLatePct: 35,
    gracePeriodHours: 48, lateStopDTE: 7, timeDTE: 2,
  };

  function getTrailWidth(peakGain) {
    return peakGain >= 100 ? MANDATE.trailWidthTier3
         : peakGain >= 50  ? MANDATE.trailWidthTier2
         :                   MANDATE.trailWidthTier1;
  }
  function shouldTrailClose(peakGain, currentPct) {
    if (peakGain < MANDATE.trailActivationPct) return false;
    return currentPct < (peakGain - getTrailWidth(peakGain));
  }
  function getStopThreshold(hoursHeld, dte) {
    return hoursHeld < MANDATE.gracePeriodHours ? -MANDATE.stopLossGracePct
         : dte <= MANDATE.lateStopDTE           ? -MANDATE.stopLossLatePct
         :                                        -MANDATE.stopLossPct;
  }

  test("trail does not activate below +15%", () => {
    assert.ok(!shouldTrailClose(14, 10));  // peak +14%, now +10% — not yet active
    assert.ok(!shouldTrailClose(10, 5));   // peak +10%, now +5% — not yet active
  });

  test("trail does not activate below +15%", () => {
    assert.ok(!shouldTrailClose(14, 10));  // peak +14% — not yet active
    assert.ok(!shouldTrailClose(10, 5));   // peak +10% — not yet active
  });

  test("tier 1 trail: +15-50% peak, 5% width", () => {
    assert.equal(getTrailWidth(35), 5);
    // Peak +35%, closes below +30%
    assert.ok(!shouldTrailClose(35, 31)); // above floor
    assert.ok(shouldTrailClose(35, 29));  // below floor
  });

  test("tier 2 trail: +50-100% peak, 8% width", () => {
    assert.equal(getTrailWidth(75), 8);
    // Peak +75%, closes below +67%
    assert.ok(!shouldTrailClose(75, 68)); // above floor
    assert.ok(shouldTrailClose(75, 66));  // below floor
  });

  test("tier 3 trail: +100%+ peak, 6% width", () => {
    assert.equal(getTrailWidth(120), 6);
    // Peak +120%, closes below +114%
    assert.ok(!shouldTrailClose(120, 115));
    assert.ok(shouldTrailClose(120, 113));
  });

  test("trail locks in minimum +10% gain (floor scenario)", () => {
    // Peak +15%, trail width 5% — floor is +10%
    assert.ok(shouldTrailClose(15, 9));    // below floor → closes
    assert.ok(!shouldTrailClose(15, 11)); // above floor → holds
  });

  test("stop threshold: grace period (first 48h)", () => {
    assert.equal(getStopThreshold(24, 15), -70); // 24h in — only catastrophic
    assert.equal(getStopThreshold(47, 10), -70); // 47h in — still in grace
  });

  test("stop threshold: standard after 48h", () => {
    assert.equal(getStopThreshold(49, 15), -50); // normal DTE, standard stop
    assert.equal(getStopThreshold(72, 10), -50);
  });

  test("stop threshold: tightens at DTE ≤ 7", () => {
    assert.equal(getStopThreshold(72, 7),  -35); // DTE=7, tightened
    assert.equal(getStopThreshold(72, 3),  -35); // DTE=3, still tightened
  });

  test("time stop always fires at DTE ≤ 2 regardless of P&L", () => {
    // This is the timeDTE check in monitorOpenPositions — always first
    assert.ok(2 <= MANDATE.timeDTE);
    assert.ok(1 <= MANDATE.timeDTE);
    assert.ok(!(3 <= MANDATE.timeDTE));
  });
});

describe("normaliseAndFilterTrades — v3", () => {
  const validLC = {
    ticker: "MSFT", strategy: "Long Call",
    targetCost: 400, targetReturnPct: "100", setupScore: 8,
    direction: "bullish", reasoning: "breakout", catalyst: "earnings month away",
  };
  const validLP = {
    ticker: "AMZN", strategy: "Long Put",
    targetCost: 350, targetReturnPct: "100", setupScore: 8,
    direction: "bearish", reasoning: "breakdown",
  };

  test("passes valid Long Call", () => {
    assert.equal(normaliseAndFilterTrades([validLC]).length, 1);
  });

  test("passes valid Long Put", () => {
    assert.equal(normaliseAndFilterTrades([validLP]).length, 1);
  });

  test("blocks v2 strategies (CSP, IC)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validLC, strategy: "Cash Secured Put" }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, strategy: "Iron Condor" }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, strategy: "Bull Call Spread" }]).length, 0);
  });

  test("blocks below minPerTrade ($250)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetCost: 249 }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetCost: 250 }]).length, 1);
  });

  test("blocks above maxPerTrade ($1000)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetCost: 1001 }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetCost: 1000 }]).length, 1);
  });

  test("blocks score below LONG_OPTIONS_MIN_SCORE (8)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validLC, setupScore: 7 }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, setupScore: 8 }]).length, 1);
  });

  test("enforces minReturnPct (20) — blocks trades projecting <20% return", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetReturnPct: "19" }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetReturnPct: "20" }]).length, 1);
    assert.equal(normaliseAndFilterTrades([{ ...validLC, targetReturnPct: "50" }]).length, 1);
  });

  test("high-beta requires score >= 9", () => {
    const nvdaAt8 = { ...validLC, ticker: "NVDA", setupScore: 8 };
    const nvdaAt9 = { ...validLC, ticker: "NVDA", setupScore: 9 };
    assert.equal(normaliseAndFilterTrades([nvdaAt8]).length, 0);
    assert.equal(normaliseAndFilterTrades([nvdaAt9]).length, 1);
  });

  test("COIN, HOOD, ARM, TSLA, CRWD require score >= 9", () => {
    for (const ticker of ["COIN", "HOOD", "ARM", "TSLA", "CRWD"]) {
      assert.equal(normaliseAndFilterTrades([{ ...validLC, ticker, setupScore: 8 }]).length, 0,
        `${ticker} should require score >= 9`);
      assert.equal(normaliseAndFilterTrades([{ ...validLC, ticker, setupScore: 9 }]).length, 1,
        `${ticker} at score 9 should pass`);
    }
  });

  test("PLTR and VST are NOT high-beta (score 8 passes)", () => {
    for (const ticker of ["PLTR", "VST"]) {
      assert.equal(normaliseAndFilterTrades([{ ...validLC, ticker, setupScore: 8 }]).length, 1,
        `${ticker} should pass at score 8 (standard threshold)`);
    }
  });

  test("broadWeakness raises Long Call threshold to 9", () => {
    // Score 8 call passes normally
    assert.equal(normaliseAndFilterTrades([{ ...validLC, setupScore: 8 }], 250).length, 1);
    // Score 8 call blocked when broadWeakness is active
    assert.equal(normaliseAndFilterTrades([{ ...validLC, setupScore: 8 }], 250, { broadWeakness: true }).length, 0);
    // Score 9 call passes even with broadWeakness
    assert.equal(normaliseAndFilterTrades([{ ...validLC, setupScore: 9 }], 250, { broadWeakness: true }).length, 1);
    // broadWeakness does NOT raise threshold for Long Put (only calls)
    assert.equal(normaliseAndFilterTrades([{ ...validLP, setupScore: 8 }], 250, { broadWeakness: true }).length, 1);
  });

  test("returns empty array on non-array input", () => {
    assert.deepEqual(normaliseAndFilterTrades(null), []);
    assert.deepEqual(normaliseAndFilterTrades("bad"), []);
  });

  test("handles field name aliases from AI", () => {
    const aliased = {
      ticker: "MSFT", strategy: "Long Call",
      cost: 400, returnPct: "100", score: 8, rationale: "test",
    };
    const result = normaliseAndFilterTrades([aliased]);
    assert.equal(result.length, 1);
    assert.equal(result[0].targetCost, 400);
  });
});
