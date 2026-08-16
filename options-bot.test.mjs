/**
 * options-bot.test.mjs
 * Unit tests for the pure functions that control live trading decisions.
 *
 * Run with:  node --test options-bot.test.mjs
 * Requires:  Node 18+ (built-in node:test and node:assert)
 *
 * These functions are tested in isolation (no Tradier, no Anthropic, no state).
 * They are the critical decision gates: which trades execute, when positions
 * close, and whether all trading halts. A regression here costs real money.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────
// INLINE COPIES OF PURE FUNCTIONS
// The bot is a single-file module with side effects at parse time
// (cron registration, IIFE startup). We copy the pure functions here
// rather than importing the whole file. If a function's logic changes
// in options-bot.mjs, update the copy here too — the tests will catch
// divergence by failing on the new expected behaviour.
// ─────────────────────────────────────────────────────────────────

// ── abbrevStrategy ────────────────────────────────────────────
function abbrevStrategy(s) {
  return s
    .replace("Cash Secured Put", "CSP")
    .replace("Iron Condor",      "IC")
    .replace("Bull Call Spread", "BCS")
    .replace("Bear Put Spread",  "BPS");
}

// ── isRetryableError ──────────────────────────────────────────
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

// ── getVIXLabel (dependency of getMarketRegime) ────────────────
function getVIXLabel(vix) {
  if (!vix)       return { label: "UNKNOWN", note: "VIX unavailable" };
  if (vix > 40)   return { label: "EXTREME",  note: `VIX ${vix.toFixed(1)} — extreme fear` };
  if (vix > 30)   return { label: "HIGH",     note: `VIX ${vix.toFixed(1)} — high fear` };
  if (vix > 20)   return { label: "ELEVATED", note: `VIX ${vix.toFixed(1)} — elevated` };
  if (vix > 15)   return { label: "NORMAL",   note: `VIX ${vix.toFixed(1)} — normal` };
  return           { label: "LOW",     note: `VIX ${vix.toFixed(1)} — low/compressed` };
}

// ── getMarketRegime ────────────────────────────────────────────
function getMarketRegime(spyChangePct, vix = null) {
  const vixInfo = getVIXLabel(vix);
  if (spyChangePct < -5.0) {
    return { label:"MARKET CRASH", allowDirectional:false, allowCondors:false, allowCSP:false,
             skipTrading:true, wingMultiplier:2.0, otmPct:7, vix:vixInfo,
             note:`SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note} — CRASH: all trading halted` };
  }
  if (spyChangePct < -3.0) {
    return { label:"EXTREME FEAR", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:2.0, otmPct:7, vix:vixInfo,
             note:`SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note} — CSP only, 7% OTM, elevated premium.` };
  }
  if (vix && vix > 40) {
    return { label:"MARKET CRASH", allowDirectional:false, allowCondors:false, allowCSP:false,
             skipTrading:true, wingMultiplier:2.0, otmPct:7, vix:vixInfo,
             note:`${vixInfo.note} | SPY ${spyChangePct.toFixed(1)}% — VIX extreme: all trading halted` };
  }
  if (vix && vix > 30) {
    return { label:"EXTREME FEAR", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:2.0, otmPct:7, vix:vixInfo,
             note:`${vixInfo.note} | SPY ${spyChangePct.toFixed(1)}% — CSP only, 7% OTM` };
  }
  const vixWingBonus = (vix && vix > 20) ? 0.5 : 0;
  const vixOtmBonus  = (vix && vix > 20) ? 1   : 0;
  const lowVIX       = (vix && vix < 15);
  if (spyChangePct > 1.0) {
    return { label:"STRONG RALLY", allowDirectional:false, allowCondors:false, allowCSP:true,
             skipTrading:false, wingMultiplier:1.0 + vixWingBonus, otmPct:5 + vixOtmBonus,
             vix:vixInfo, note:`SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note}${lowVIX ? " — condors skipped (thin premium)" : ""}` };
  }
  if (spyChangePct > -1.0) {
    return { label:"NORMAL", allowDirectional:true, allowCondors:!lowVIX, allowCSP:true,
             skipTrading:false, wingMultiplier:1.0 + vixWingBonus, otmPct:5 + vixOtmBonus,
             vix:vixInfo, note:`SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note}${lowVIX ? " — condors skipped (thin premium)" : " — all income strategies allowed"}` };
  }
  return { label:"HIGH VOLATILITY", allowDirectional:false, allowCondors:!lowVIX, allowCSP:true,
           skipTrading:false, wingMultiplier:1.5 + vixWingBonus, otmPct:6 + vixOtmBonus,
           vix:vixInfo, note:`SPY ${spyChangePct.toFixed(1)}% | ${vixInfo.note}${lowVIX ? " — condors skipped (thin premium)" : ""}` };
}

// ── computePnL ────────────────────────────────────────────────
const PROFIT_TARGET_PCT = 50; // mirrors MANDATE.profitTargetPct
function computePnL(ourTrade, g) {
  const openCost        = ourTrade.executedCost / g.qty / 100;
  const maxProfitShare  = (ourTrade.maxProfit || ourTrade.executedCost) / g.qty / 100;
  const currentPnL      = ourTrade.isCredit
    ? (openCost - g.currentValue) * g.qty * 100
    : (g.currentValue - openCost) * g.qty * 100;
  const currentPct      = openCost ? (currentPnL / (openCost * g.qty * 100) * 100) : 0;
  const profitTargetPnL = maxProfitShare * g.qty * 100 * (PROFIT_TARGET_PCT / 100);
  return { openCost, maxProfitShare, currentPnL, currentPct, profitTargetPnL };
}

// ── normaliseAndFilterTrades (dependencies inlined) ──────────
const MANDATE = {
  minPerTrade: 250, maxPerTrade: 1200, minReturnPct: 8, profitTargetPct: 50,
  minPerTradeLive: 600,
};
const INDEX_TICKERS         = ["SPY", "QQQ"];
const HIGH_BETA_TICKERS     = ["NVDA", "TSLA", "CRWD", "COIN", "HOOD", "ARM"];
const DIRECTIONAL_MIN_SCORE = 8;
const INCOME_MIN_SCORE      = 6;
function isDirectional(s) { return s === "Bull Call Spread" || s === "Bear Put Spread"; }

function normaliseAndFilterTrades(parsed, effectiveMin = MANDATE.minPerTrade, downtrendCount = {}) {
  if (!Array.isArray(parsed)) return [];
  const normalised = parsed.map(t => ({
    ticker:          t.ticker          ?? "",
    strategy:        t.strategy        ?? "",
    targetCost:      parseFloat(t.targetCost ?? t.cost ?? t.premium ?? 0),
    targetReturnPct: parseFloat(t.targetReturnPct ?? t.returnPct ?? t.expectedReturn ?? 0),
    setupScore:      parseFloat(t.setupScore ?? t.score ?? 0),
    reasoning:       t.reasoning       ?? t.reason ?? "",
    exitTarget:      t.exitTarget      ?? t.exitRule ?? t.exit ?? "",
  }));
  return normalised.filter(t => {
    if (t.targetCost < effectiveMin || t.targetCost > MANDATE.maxPerTrade) return false;
    if (parseFloat(t.targetReturnPct) < MANDATE.minReturnPct)              return false;
    if (t.strategy === "Bull Call Spread")                                  return false;
    if (t.strategy === "Iron Condor" && !INDEX_TICKERS.includes(t.ticker)) return false;
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


// ─────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────

describe("abbrevStrategy", () => {
  test("abbreviates all known strategies", () => {
    assert.equal(abbrevStrategy("Cash Secured Put"), "CSP");
    assert.equal(abbrevStrategy("Iron Condor"),      "IC");
    assert.equal(abbrevStrategy("Bull Call Spread"), "BCS");
    assert.equal(abbrevStrategy("Bear Put Spread"),  "BPS");
  });
  test("passes through unknown strategies unchanged", () => {
    assert.equal(abbrevStrategy("Covered Call"), "Covered Call");
  });
});

describe("isRetryableError", () => {
  test("retries on network errors", () => {
    assert.ok(isRetryableError(new Error("Connection error: blah")));
    assert.ok(isRetryableError(new Error("ECONNREFUSED 127.0.0.1")));
    assert.ok(isRetryableError(new Error("ENOTFOUND api.anthropic.com")));
    assert.ok(isRetryableError(new Error("fetch failed")));
    assert.ok(isRetryableError(new Error("network timeout")));
    assert.ok(isRetryableError(new Error("request timeout")));
  });
  test("retries on 529/503 status codes", () => {
    assert.ok(isRetryableError(Object.assign(new Error("overloaded"), { status: 529 })));
    assert.ok(isRetryableError(Object.assign(new Error("service unavailable"), { status: 503 })));
  });
  test("does NOT retry on auth or bad request errors", () => {
    assert.ok(!isRetryableError(Object.assign(new Error("Unauthorized"), { status: 401 })));
    assert.ok(!isRetryableError(Object.assign(new Error("Bad request"), { status: 400 })));
    assert.ok(!isRetryableError(new Error("JSON parse failed")));
  });
});

describe("getMarketRegime", () => {
  test("MARKET CRASH halts all trading when SPY < -5%", () => {
    const r = getMarketRegime(-5.1);
    assert.equal(r.label, "MARKET CRASH");
    assert.ok(r.skipTrading);
    assert.ok(!r.allowCSP);
    assert.ok(!r.allowCondors);
    assert.ok(!r.allowDirectional);
  });
  test("SPY exactly at -5.0% is NOT a crash (boundary)", () => {
    const r = getMarketRegime(-5.0);
    assert.notEqual(r.label, "MARKET CRASH");
  });
  test("EXTREME FEAR allows CSP but not condors or directional", () => {
    const r = getMarketRegime(-3.5);
    assert.equal(r.label, "EXTREME FEAR");
    assert.ok(r.allowCSP);
    assert.ok(!r.allowCondors);
    assert.ok(!r.allowDirectional);
    assert.ok(!r.skipTrading);
  });
  test("VIX > 40 triggers MARKET CRASH regardless of SPY", () => {
    const r = getMarketRegime(-0.5, 41);
    assert.equal(r.label, "MARKET CRASH");
    assert.ok(r.skipTrading);
  });
  test("VIX 30-40 triggers EXTREME FEAR with CSP allowed", () => {
    const r = getMarketRegime(0.2, 35);
    assert.equal(r.label, "EXTREME FEAR");
    assert.ok(r.allowCSP);
    assert.ok(!r.allowCondors);
  });
  test("NORMAL regime allows all strategies when VIX is mid-range", () => {
    const r = getMarketRegime(0.0, 18);
    assert.equal(r.label, "NORMAL");
    assert.ok(r.allowCSP);
    assert.ok(r.allowCondors);
    assert.ok(r.allowDirectional);
  });
  test("NORMAL with VIX < 15 disables condors (thin premium)", () => {
    const r = getMarketRegime(0.0, 12);
    assert.equal(r.label, "NORMAL");
    assert.ok(!r.allowCondors); // low VIX = compressed premium
  });
  test("STRONG RALLY disables condors and directional", () => {
    const r = getMarketRegime(1.5);
    assert.equal(r.label, "STRONG RALLY");
    assert.ok(r.allowCSP);
    assert.ok(!r.allowCondors);
    assert.ok(!r.allowDirectional);
  });
  test("HIGH VOLATILITY disables directional but allows condors", () => {
    const r = getMarketRegime(-2.0);
    assert.equal(r.label, "HIGH VOLATILITY");
    assert.ok(!r.allowDirectional);
    assert.ok(r.allowCondors);
  });
  test("VIX > 20 increases wingMultiplier", () => {
    const withHighVix = getMarketRegime(0.0, 25);
    const withLowVix  = getMarketRegime(0.0, 17);
    assert.ok(withHighVix.wingMultiplier > withLowVix.wingMultiplier);
  });
  test("regime always includes a vix field even without VIX data", () => {
    const r = getMarketRegime(-6.0); // no vix argument
    assert.ok("vix" in r);
    assert.equal(r.vix.label, "UNKNOWN");
  });
});

describe("computePnL", () => {
  // Helper: build minimal trade + group objects
  const cspTrade = (executedCost, qty = 1) => ({
    executedCost, maxProfit: executedCost, isCredit: true, quantity: qty,
  });
  const group = (currentValue, qty = 1) => ({ currentValue, qty, positions: [] });

  test("credit trade at 50% value = 50% profit", () => {
    // Sold $1.00 CSP (1 contract). Current value $0.50. Profit = $50.
    const t = cspTrade(100, 1); // $1.00/sh × 100 = $100 total
    const g = group(0.50, 1);   // currently worth $0.50/sh
    const { currentPnL, currentPct, profitTargetPnL } = computePnL(t, g);
    assert.equal(currentPnL, 50);       // $0.50 decay × 100 = $50
    assert.equal(currentPct, 50);
    assert.equal(profitTargetPnL, 50);  // 50% of $100 credit
  });

  test("credit trade at full value = 0 profit", () => {
    const t = cspTrade(100, 1);
    const g = group(1.00, 1); // value unchanged
    const { currentPnL } = computePnL(t, g);
    assert.equal(currentPnL, 0);
  });

  test("credit trade above open cost = loss", () => {
    const t = cspTrade(100, 1);
    const g = group(1.50, 1); // expanded — we're losing
    const { currentPnL } = computePnL(t, g);
    assert.equal(currentPnL, -50);
  });

  test("profitTargetPnL scales correctly with qty and cost", () => {
    // 2-contract CSP, $200 credit each → $400 total. 50% target = $200.
    const t = cspTrade(400, 2);
    const g = group(0.50, 2);
    const { profitTargetPnL } = computePnL(t, g);
    assert.equal(profitTargetPnL, 200);
  });

  test("debit trade: profit when value increases", () => {
    const debitTrade = { executedCost: 100, maxProfit: 200, isCredit: false, quantity: 1 };
    const g = group(1.50, 1); // worth more than we paid
    const { currentPnL } = computePnL(debitTrade, g);
    assert.equal(currentPnL, 50); // 1.50 - 1.00 = 0.50 × 100
  });
});

describe("normaliseAndFilterTrades", () => {
  const validCSP = {
    ticker: "NVDA", strategy: "Cash Secured Put",
    targetCost: 400, targetReturnPct: 10, setupScore: 7,
  };
  const validIC = {
    ticker: "SPY", strategy: "Iron Condor",
    targetCost: 500, targetReturnPct: 9, setupScore: 7,
  };

  test("passes a valid CSP", () => {
    const result = normaliseAndFilterTrades([validCSP]);
    assert.equal(result.length, 1);
    assert.equal(result[0].ticker, "NVDA");
  });

  test("passes a valid index IC", () => {
    const result = normaliseAndFilterTrades([validIC]);
    assert.equal(result.length, 1);
  });

  test("blocks Iron Condor on non-index tickers", () => {
    const result = normaliseAndFilterTrades([{ ...validIC, ticker: "NVDA" }]);
    assert.equal(result.length, 0);
  });

  test("blocks Bull Call Spread unconditionally (retired)", () => {
    const result = normaliseAndFilterTrades([{
      ticker: "MSFT", strategy: "Bull Call Spread",
      targetCost: 400, targetReturnPct: 10, setupScore: 9,
    }]);
    assert.equal(result.length, 0);
  });

  test("blocks directional trade on high-beta ticker", () => {
    const result = normaliseAndFilterTrades([{
      ticker: "NVDA", strategy: "Bear Put Spread",
      targetCost: 400, targetReturnPct: 10, setupScore: 9,
    }]);
    assert.equal(result.length, 0);
  });

  test("blocks directional trade with score below DIRECTIONAL_MIN_SCORE (8)", () => {
    const result = normaliseAndFilterTrades([{
      ticker: "MSFT", strategy: "Bear Put Spread",
      targetCost: 400, targetReturnPct: 10, setupScore: 7, // below 8
    }]);
    assert.equal(result.length, 0);
  });

  test("allows directional trade on non-high-beta with score >= 8", () => {
    const result = normaliseAndFilterTrades([{
      ticker: "MSFT", strategy: "Bear Put Spread",
      targetCost: 400, targetReturnPct: 10, setupScore: 8,
    }]);
    assert.equal(result.length, 1);
  });

  test("blocks CSP on ticker with downtrend count >= 3", () => {
    const result = normaliseAndFilterTrades(
      [validCSP],
      250,
      { NVDA: { count: 3, lastDate: "2026-08-14" } }
    );
    assert.equal(result.length, 0);
  });

  test("allows CSP on ticker with downtrend count of 2", () => {
    const result = normaliseAndFilterTrades(
      [validCSP],
      250,
      { NVDA: { count: 2, lastDate: "2026-08-14" } }
    );
    assert.equal(result.length, 1);
  });

  test("blocks trades below effectiveMin cost", () => {
    const cheap = { ...validCSP, targetCost: 599 };
    assert.equal(normaliseAndFilterTrades([cheap], 600).length, 0); // live min
    assert.equal(normaliseAndFilterTrades([cheap], 250).length, 1); // sandbox min
  });

  test("blocks trades above maxPerTrade", () => {
    const expensive = { ...validCSP, targetCost: 1201 };
    assert.equal(normaliseAndFilterTrades([expensive]).length, 0);
  });

  test("blocks trades below minReturnPct (8%)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validCSP, targetReturnPct: 7.9 }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validCSP, targetReturnPct: 8.0 }]).length, 1);
  });

  test("blocks income trade with score below INCOME_MIN_SCORE (6)", () => {
    assert.equal(normaliseAndFilterTrades([{ ...validCSP, setupScore: 5 }]).length, 0);
    assert.equal(normaliseAndFilterTrades([{ ...validCSP, setupScore: 6 }]).length, 1);
  });

  test("handles alternative field name aliases from AI", () => {
    const altNames = {
      ticker: "SPY", strategy: "Iron Condor",
      cost: 500,         // instead of targetCost
      returnPct: 9,      // instead of targetReturnPct
      score: 7,          // instead of setupScore
    };
    const result = normaliseAndFilterTrades([altNames]);
    assert.equal(result.length, 1);
    assert.equal(result[0].targetCost, 500);
  });

  test("returns empty array on non-array input", () => {
    assert.deepEqual(normaliseAndFilterTrades(null), []);
    assert.deepEqual(normaliseAndFilterTrades("bad"), []);
    assert.deepEqual(normaliseAndFilterTrades({}), []);
  });

  test("new tickers COIN, HOOD, ARM are high-beta (income-only)", () => {
    for (const ticker of ["COIN", "HOOD", "ARM"]) {
      const directional = {
        ticker, strategy: "Bear Put Spread",
        targetCost: 400, targetReturnPct: 10, setupScore: 9,
      };
      assert.equal(normaliseAndFilterTrades([directional]).length, 0,
        `${ticker} directional should be blocked as high-beta`);
    }
  });

  test("MRVL and VST are NOT high-beta (directional allowed with score >= 8)", () => {
    for (const ticker of ["MRVL", "VST"]) {
      const directional = {
        ticker, strategy: "Bear Put Spread",
        targetCost: 400, targetReturnPct: 10, setupScore: 8,
      };
      assert.equal(normaliseAndFilterTrades([directional]).length, 1,
        `${ticker} directional should be allowed (not high-beta)`);
    }
  });
});
