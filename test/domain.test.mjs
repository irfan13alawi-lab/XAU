import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adx, atr, calculateIndicators, candlePattern, ema, macd, rsi, stochRsi,
  supportResistance, supertrend, swingPoints, tickVolumeRatio,
} from '../src/domain/indicators.mjs';
import { evaluateNewsBlackout } from '../src/domain/news.mjs';
import { evaluatePaperScan } from '../src/domain/paper-engine.mjs';
import { calculatePositionSize, evaluateRiskGuard } from '../src/domain/risk.mjs';
import { managePaperPosition, matchPendingOrder, PaperBrokerAdapter } from '../src/domain/paper-execution.mjs';
import {
  analyzeTimeframe, buildEntryPlan, evaluateMtfGate, resolveStrategyParameters,
  STRATEGY_PARAMETER_RATIONALE,
} from '../src/domain/strategy.mjs';
import { config, fingerprintConfiguration } from '../src/config.mjs';
import { syntheticCandles } from './fixtures.mjs';

const limits = {
  riskPerTradePct: 0.25,
  maxTotalOpenRiskPct: 5,
  dailyLossLimitR: 3,
  drawdownWarningPct: 5,
  drawdownPausePct: 10,
  emergencyStopPct: 20,
  minRiskReward: 2,
  minSignalScore: 70,
  minConfluencePct: 60,
};

const explicitCosts = {
  slippagePrice: 0.1,
  commissionPerLot: 2,
  swapPerLotPerDay: 1,
  fillLatencyMs: 250,
  fillRatio: 1,
  contractSize: 100,
  quoteToAccountRate: 1,
  lotStep: 0.1,
  minimumLot: 0.1,
  breakEvenOffsetPrice: 0.05,
};

test('EMA uses an SMA seed and stays null during warm-up', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(ema([1, 2, null, 4, 5, 6], 2), [null, 1.5, null, null, 4.5, 5.5]);
});

test('RSI handles rising, flat, warm-up, and gaps deterministically', () => {
  assert.equal(rsi(Array.from({ length: 16 }, (_, index) => index + 1), 14).at(-1), 100);
  assert.equal(rsi(Array(16).fill(10), 14).at(-1), 50);
  const withGap = rsi([1, 2, 3, 4, 5, null, 1, 2, 3, 4], 2);
  assert.equal(withGap[2], 100);
  assert.equal(withGap[6], null);
  assert.equal(withGap[9], 100);
});

test('MACD, ATR, ADX, Stoch RSI, and Supertrend expose warm-up as null', () => {
  const candles = syntheticCandles({ count: 100 });
  const closes = candles.map((candle) => candle.close);
  const macdResult = macd(closes);
  assert.equal(macdResult.histogram[32], null);
  assert.ok(Number.isFinite(macdResult.histogram.at(-1)));
  assert.ok(macdResult.histogram.at(-1) > 0);

  const flatCandles = Array.from({ length: 20 }, () => ({ open: 10, high: 11, low: 9, close: 10 }));
  assert.equal(atr(flatCandles, 14)[13], 2);
  assert.equal(atr(flatCandles, 14)[12], null);
  const adxResult = adx(candles, 14);
  assert.ok(Number.isFinite(adxResult.adx.at(-1)));
  assert.ok(adxResult.adx.at(-1) >= 0 && adxResult.adx.at(-1) <= 100);
  const oscillating = Array.from({ length: 160 }, (_, index) => 100 + index * 0.01 + Math.sin(index / 2) * 2);
  const stoch = stochRsi(oscillating);
  assert.ok(stoch.k.some((value) => Number.isFinite(value)));
  const trend = supertrend(candles);
  assert.ok(Number.isFinite(trend.line.at(-1)));
  assert.ok([-1, 1].includes(trend.direction.at(-1)));
});

test('support, resistance, swing points, candle patterns, and missing tick volume are explicit', () => {
  const candles = syntheticCandles({ count: 50 });
  const swings = swingPoints(candles);
  assert.ok(Array.isArray(swings.highs) && Array.isArray(swings.lows));
  assert.ok(supportResistance(candles).support < candles.at(-1).close);
  assert.equal(candlePattern([
    { open: 10, high: 10.1, low: 8.9, close: 9 },
    { open: 8.8, high: 10.5, low: 8.7, close: 10.2 },
  ]), 'BULLISH_ENGULFING');
  assert.equal(tickVolumeRatio(candles.map(({ tickVolume, ...candle }) => candle)).status, 'UNAVAILABLE');
  assert.ok(calculateIndicators(candles).ema50 > 0);
});

test('timeframe analysis rejects synthetic, stale, and look-ahead candles', () => {
  const candles = syntheticCandles({ count: 120, timeframeMs: 15 * 60_000 });
  const current = new Date(Date.parse(candles.at(-1).closedAt) + 60_000);
  const synthetic = analyzeTimeframe({ candles, timeframe: 'M15', source: 'SYNTHETIC', now: current });
  assert.equal(synthetic.direction, 'UNAVAILABLE');
  assert.ok(synthetic.rejectionReasons.includes('MARKET_SOURCE_NOT_VERIFIED_BROKER'));

  const stale = analyzeTimeframe({ candles, timeframe: 'M15', source: 'BROKER', now: new Date(Date.parse(candles.at(-1).closedAt) + 31 * 60_000) });
  assert.ok(stale.rejectionReasons.includes('DATA_STALE'));

  const futureCandles = [...candles.slice(0, -1), { ...candles.at(-1), closedAt: new Date(current.getTime() + 60_000).toISOString() }];
  const future = analyzeTimeframe({ candles: futureCandles, timeframe: 'M15', source: 'BROKER', now: current });
  assert.ok(future.rejectionReasons.includes('LOOKAHEAD_CANDLE'));
});

test('strategy parameters are validated, injectable, rationale-backed, and content-versioned', () => {
  const changed = resolveStrategyParameters({
    minimumCandlesPerTimeframe: 120,
    timeframeWeights: { H4: 0.4, H1: 0.3, M30: 0.2, M15: 0.1 },
    voting: { rsiLongThreshold: 60, rsiShortThreshold: 40 },
    entryPlan: { atrStopMultiple: 2, takeProfit1R: 2.5, takeProfit2R: 3.5, pendingExpiryMinutes: 90 },
  });
  assert.equal(changed.minimumCandlesPerTimeframe, 120);
  assert.equal(Object.isFrozen(changed.timeframeWeights), true);
  assert.throws(() => resolveStrategyParameters({ timeframeWeights: { H4: 0.4 } }), /constraints/);
  assert.throws(() => resolveStrategyParameters({ entryPlan: { takeProfit1R: 1.5 } }), /constraints/);
  assert.throws(() => resolveStrategyParameters({ voting: { rsiLongThreshold: '60' } }), /constraints/);
  assert.ok(STRATEGY_PARAMETER_RATIONALE.entryPlan.takeProfit1R.includes('minimum of 2R'));
  assert.ok(STRATEGY_PARAMETER_RATIONALE.voting.rsiLongThreshold.includes('unvalidated heuristic'));

  const candles = syntheticCandles({ count: 120, timeframeMs: 15 * 60_000 });
  const now = new Date(Date.parse(candles.at(-1).closedAt) + 60_000);
  const customWarmup = analyzeTimeframe({
    candles: candles.slice(0, 119), timeframe: 'M15', source: 'BROKER', now,
    strategyParameters: changed,
  });
  assert.ok(customWarmup.rejectionReasons.includes('INSUFFICIENT_CANDLES'));

  const plan = buildEntryPlan({
    direction: 'LONG', quote: { bid: 2000, ask: 2000.2 }, atr14: 2,
    support: 1999, ema21: 1999.5, swingLow: 1998.5,
    instrument: { tickSize: 0.1, minStopDistance: 0.2, digits: 1 },
    strategyParameters: changed,
  });
  assert.equal(plan.plan.expiresAfterMinutes, 90);
  assert.ok(plan.plan.riskDistance >= 4);
  assert.ok(plan.plan.riskReward >= 2.5);
  assert.ok(plan.plan.takeProfit2 > plan.plan.takeProfit1);

  const manifest = {
    risk: config.risk,
    strategyParameters: config.strategyParameters,
    parameterRationale: config.parameterRationale,
  };
  assert.equal(config.strategyVersion, fingerprintConfiguration(manifest, config.strategyProfileId));
  assert.notEqual(config.strategyVersion, fingerprintConfiguration({ ...manifest, strategyParameters: changed }, config.strategyProfileId));
});

test('risk sizing needs broker contract conversion metadata and obeys exposure limits', () => {
  const input = {
    equity: 10_000,
    riskPct: 0.25,
    entryPrice: 2000,
    stopPrice: 1990,
    side: 'LONG',
    accountCurrency: 'USD',
    dailyLossR: 0.4,
    drawdownPct: 1,
    openRiskPct: 0,
    limits,
    contract: {
      contractSize: 100,
      tickSize: 0.1,
      tickValue: 1,
      tickValueCurrency: 'USD',
      minLot: 0.01,
      lotStep: 0.01,
      maxLot: 10,
    },
  };
  const size = calculatePositionSize(input);
  assert.equal(size.allowed, true);
  assert.equal(size.lots, 0.25);
  assert.equal(size.riskAmount, 25);
  assert.equal(calculatePositionSize({ ...input, openRiskPct: 4.9 }).allowed, false);
  assert.ok(calculatePositionSize({ ...input, contract: { ...input.contract, tickValueCurrency: 'EUR' } }).reasons.includes('TICK_VALUE_CONVERSION_UNAVAILABLE'));
  assert.ok(calculatePositionSize({ ...input, contract: null }).reasons.includes('CONTRACT_METADATA_INCOMPLETE'));
});

test('risk guard fails closed on unknown state and pauses at configured boundaries', () => {
  assert.equal(evaluateRiskGuard({ dailyLossR: null, drawdownPct: 0, openRiskPct: 0, limits }).allowed, false);
  assert.ok(evaluateRiskGuard({ dailyLossR: 3, drawdownPct: 0, openRiskPct: 0, limits }).reasons.includes('DAILY_LOSS_LIMIT'));
  assert.ok(evaluateRiskGuard({ dailyLossR: 0, drawdownPct: 20, openRiskPct: 0, limits }).reasons.includes('EMERGENCY_STOP'));
  assert.ok(evaluateRiskGuard({ dailyLossR: 0, drawdownPct: 6, openRiskPct: 0, limits }).warnings.includes('DRAWDOWN_WARNING'));
});

test('news blackout fails closed when stale and blocks USD high-impact windows', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const stale = evaluateNewsBlackout({ events: [], fetchedAt: '2026-09-21T10:00:00.000Z', sourceStatus: 'HEALTHY', now });
  assert.equal(stale.allowed, false);
  assert.ok(stale.reasons.includes('NEWS_DATA_STALE_OR_AMBIGUOUS'));
  const active = evaluateNewsBlackout({
    events: [{ currency: 'USD', impact: 'HIGH', category: 'CPI', scheduledAt: '2026-09-21T12:20:00.000Z' }],
    fetchedAt: '2026-09-21T11:59:00.000Z', sourceStatus: 'HEALTHY', now,
  });
  assert.equal(active.allowed, false);
  assert.ok(active.reasons.includes('NEWS_BLACKOUT'));
  const clear = evaluateNewsBlackout({ events: [], fetchedAt: '2026-09-21T11:59:00.000Z', sourceStatus: 'HEALTHY', now });
  assert.equal(clear.allowed, true);
});

test('entry plan rounds to contract tick and derives 2R / 3R targets from ATR/structure', () => {
  const result = buildEntryPlan({
    direction: 'LONG', quote: { bid: 2000, ask: 2000.2 }, atr14: 2,
    support: 1999, ema21: 1999.5, swingLow: 1998.5, instrument: { tickSize: 0.1, minStopDistance: 0.2, digits: 1 },
  });
  assert.equal(result.allowed, true);
  assert.ok(result.plan.entry < 2000);
  assert.ok(result.plan.stop < result.plan.entry);
  assert.ok(result.plan.takeProfit1 > result.plan.entry);
  assert.ok(result.plan.takeProfit2 > result.plan.takeProfit1);
  assert.ok(result.plan.riskReward >= 2);
});

test('MTF gate accepts only a complete, aligned, fresh setup with every external gate green', () => {
  const m15ClosedAt = Date.parse('2026-09-21T11:45:00.000Z');
  const interval = { H4: 4 * 60 * 60_000, H1: 60 * 60_000, M30: 30 * 60_000, M15: 15 * 60_000 };
  const analyses = ['H4', 'H1', 'M30', 'M15'].map((timeframe) => ({
    timeframe, direction: 'LONG', strength: 80, fresh: true,
    candleClosedAt: new Date(m15ClosedAt - (interval[timeframe] - 15 * 60_000)).toISOString(),
  }));
  const input = {
    analyses,
    quote: { source: 'BROKER', dataFreshness: 'FRESH', bid: 2000, ask: 2000.2 },
    news: { allowed: true, reasons: [] },
    risk: { allowed: true, reasons: [] },
    plan: { allowed: true, plan: { riskReward: 2 } },
    config: { ...limits, maxSpreadPrice: 0.5 },
  };
  assert.equal(evaluateMtfGate(input).status, 'READY');
  const weightedProfile = resolveStrategyParameters({
    timeframeWeights: { H4: 0.2, H1: 0.2, M30: 0.2, M15: 0.4 },
  });
  const weighted = evaluateMtfGate({
    ...input,
    analyses: analyses.map((item) => ({ ...item, strength: item.timeframe === 'M15' ? 100 : 50 })),
    config: { ...limits, maxSpreadPrice: 0.5, strategyParameters: weightedProfile },
  });
  assert.equal(weighted.score, 70);
  assert.equal(weighted.status, 'READY');
  const fourAlignedRequired = resolveStrategyParameters({ minimumAlignedTimeframes: 4 });
  const strictMinimum = evaluateMtfGate({
    ...input,
    analyses: analyses.map((item) => item.timeframe === 'M30' ? { ...item, direction: 'SHORT' } : item),
    config: { ...limits, maxSpreadPrice: 0.5, strategyParameters: fourAlignedRequired },
  });
  assert.ok(strictMinimum.reasons.includes('MTF_ALIGNMENT_BELOW_MINIMUM'));
  const conflict = evaluateMtfGate({ ...input, analyses: analyses.map((item) => item.timeframe === 'M30' ? { ...item, direction: 'SHORT' } : item) });
  assert.ok(conflict.reasons.includes('M30_STRUCTURE_CONFLICT'));
  const noSpread = evaluateMtfGate({ ...input, config: { ...limits, maxSpreadPrice: null } });
  assert.ok(noSpread.reasons.includes('SPREAD_LIMIT_UNCONFIGURED'));
  const stale = evaluateMtfGate({ ...input, quote: { ...input.quote, dataFreshness: 'STALE' } });
  assert.ok(stale.reasons.includes('MARKET_DATA_STALE'));
  const lateH1 = evaluateMtfGate({
    ...input,
    analyses: analyses.map((item) => item.timeframe === 'H1'
      ? { ...item, candleClosedAt: new Date(m15ClosedAt - 60 * 60_000).toISOString() } : item),
  });
  assert.ok(lateH1.reasons.includes('MTF_TIMEFRAME_ALIGNMENT_INVALID'));
  const futureM30 = evaluateMtfGate({
    ...input,
    analyses: analyses.map((item) => item.timeframe === 'M30'
      ? { ...item, candleClosedAt: new Date(m15ClosedAt + 15 * 60_000).toISOString() } : item),
  });
  assert.ok(futureM30.reasons.includes('MTF_TIMEFRAME_ALIGNMENT_INVALID'));
});

test('paper scan produces no setup from absent feed and keeps synthetic fixtures out of the broker path', () => {
  const result = evaluatePaperScan({
    market: { source: 'none', dataFreshness: 'UNAVAILABLE', quote: null },
    candlesByTimeframe: Object.fromEntries(['H4', 'H1', 'M30', 'M15'].map((timeframe) => [timeframe, []])),
    newsState: { allowed: false, reasons: ['NEWS_SOURCE_UNAVAILABLE'] },
    riskState: null,
    account: null,
    instrument: null,
    config: { ...limits, riskPerTradePct: 0.25, maxSpreadPrice: null },
    now: new Date('2026-09-21T12:00:00.000Z'),
  });
  assert.equal(result.accepted, false);
  assert.equal(result.plan, null);
  assert.ok(result.reasons.includes('BROKER_OFFLINE'));
  assert.equal(result.analyses.every((analysis) => analysis.direction === 'UNAVAILABLE'), true);
  assert.ok(result.maxCandidates <= 3);
});

test('paper matching respects bid/ask, limit direction, expiry, and explicit cost assumptions', () => {
  const quote = { source: 'BROKER', dataFreshness: 'FRESH', bid: 2000.8, ask: 2001.0, observedAt: '2026-09-21T12:00:00.250Z' };
  const base = { side: 'BUY', orderType: 'LIMIT', entryPrice: 2001.1, quantityLots: 0.2, createdAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-21T14:00:00.000Z' };
  const fill = matchPendingOrder(base, quote, new Date('2026-09-21T12:00:00.250Z'), explicitCosts);
  assert.equal(fill.status, 'FILLED');
  assert.equal(fill.fillLatencyMs, 250);
  assert.equal(matchPendingOrder({ ...base, entryPrice: 2000.9 }, quote, new Date('2026-09-21T12:00:00.250Z'), explicitCosts).status, 'PENDING');
  assert.equal(matchPendingOrder(base, quote, new Date('2026-09-21T14:00:00.000Z'), explicitCosts).status, 'EXPIRED');
  assert.throws(() => new PaperBrokerAdapter({ costs: {} }), /assumptions/);
});

test('paper broker adapter exposes matching and position management only', () => {
  const adapter = new PaperBrokerAdapter({ costs: explicitCosts });
  assert.deepEqual(Object.getOwnPropertyNames(PaperBrokerAdapter.prototype), [
    'constructor', 'matchPendingOrder', 'managePosition',
  ]);
  assert.equal(adapter.placeOrder, undefined);
  assert.equal(adapter.sendOrder, undefined);
  assert.equal(adapter.submitOrder, undefined);
});

test('paper matching waits for simulated latency and rejects a pre-eligibility quote', () => {
  const order = {
    side: 'BUY', orderType: 'LIMIT', entryPrice: 2001.1, quantityLots: 0.2,
    createdAt: '2026-09-21T12:00:00.000Z', expiresAt: '2026-09-21T14:00:00.000Z',
  };
  const earlyQuote = { source: 'BROKER', dataFreshness: 'FRESH', bid: 2000.8, ask: 2001.0, observedAt: '2026-09-21T12:00:00.100Z' };
  const waiting = matchPendingOrder(order, earlyQuote, new Date('2026-09-21T12:00:00.500Z'), explicitCosts);
  assert.equal(waiting.status, 'HELD');
  assert.equal(waiting.reason, 'SIMULATED_FILL_LATENCY_WAIT');
  const eligibleQuote = { ...earlyQuote, observedAt: '2026-09-21T12:00:00.250Z' };
  assert.equal(matchPendingOrder(order, eligibleQuote, new Date('2026-09-21T12:00:00.250Z'), explicitCosts).status, 'FILLED');
});

test('paper limit fills never violate their price limit while stop fills include adverse slippage', () => {
  const quote = { source: 'BROKER', dataFreshness: 'FRESH', bid: 2000.8, ask: 2001.0, observedAt: '2026-09-21T12:00:00.250Z' };
  const highSlippage = { ...explicitCosts, slippagePrice: 5 };
  const createdAt = '2026-09-21T12:00:00.000Z';
  const buyLimit = matchPendingOrder({ side: 'BUY', orderType: 'LIMIT', entryPrice: 2001, quantityLots: 0.2, createdAt, expiresAt: '2026-09-21T14:00:00.000Z' }, quote, new Date('2026-09-21T12:00:00.250Z'), highSlippage);
  assert.equal(buyLimit.fillPrice, 2001);
  const sellLimit = matchPendingOrder({ side: 'SELL', orderType: 'LIMIT', entryPrice: 2000.8, quantityLots: 0.2, createdAt, expiresAt: '2026-09-21T14:00:00.000Z' }, quote, new Date('2026-09-21T12:00:00.250Z'), highSlippage);
  assert.equal(sellLimit.fillPrice, 2000.8);
  const buyStop = matchPendingOrder({ side: 'BUY', orderType: 'STOP', entryPrice: 2000.5, quantityLots: 0.2, createdAt, expiresAt: '2026-09-21T14:00:00.000Z' }, quote, new Date('2026-09-21T12:00:00.250Z'), highSlippage);
  assert.equal(buyStop.fillPrice, 2006);
});

test('paper positions mark LONG at bid, close half at TP1, protect remainder, then close at TP2', () => {
  const position = {
    status: 'OPEN', side: 'LONG', quantityOpenLots: 0.2, quantityInitialLots: 0.2,
    entryPrice: 100, stopPrice: 98, takeProfit1: 104, takeProfit2: 106,
    openedAt: '2026-09-21T00:00:00.000Z', tp1Hit: false,
  };
  const tp1 = managePaperPosition(position, { source: 'BROKER', dataFreshness: 'FRESH', bid: 104.2, ask: 104.4 }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(tp1.events[0].type, 'HIT_TP1');
  assert.equal(tp1.events[0].price, 104.1);
  assert.equal(tp1.events[0].referencePrice, 104.2);
  assert.equal(tp1.events[0].grossPnl, 41);
  assert.equal(tp1.quantityOpenLots, 0.1);
  assert.equal(tp1.stopPrice, 100.05);
  const tp2 = managePaperPosition({ ...position, ...tp1 }, { source: 'BROKER', dataFreshness: 'FRESH', bid: 106.2, ask: 106.4 }, new Date('2026-09-21T02:00:00.000Z'), explicitCosts);
  assert.equal(tp2.status, 'CLOSED');
  assert.equal(tp2.closeReason, 'HIT_TP2');
  assert.equal(tp2.exitPrice, 106.1);
  assert.equal(tp2.grossPnl, 61);
  const directStop = managePaperPosition({ ...position, stopPrice: 99, takeProfit1: 98.5 }, { source: 'BROKER', dataFreshness: 'FRESH', bid: 98.8, ask: 99 }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(directStop.closeReason, 'SL_DIRECT');
  assert.equal(directStop.exitPrice, 98.7);
  assert.equal(directStop.events[0].stopGapPrice, 0.2);

  const longGap = managePaperPosition({ ...position, stopPrice: 99, takeProfit1: 98.5 }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 97, ask: 97.2,
  }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(longGap.closeReason, 'SL_DIRECT');
  assert.equal(longGap.exitPrice, 96.9, 'a LONG stop gap exits at the observed bid plus adverse slippage, not at the stop');
  assert.equal(longGap.events[0].stopGapPrice, 2);
  assert.equal(longGap.grossPnl, -62);

  const targetTouch = managePaperPosition(position, { source: 'BROKER', dataFreshness: 'FRESH', bid: 104, ask: 104.2 }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(targetTouch.events[0].price, 104, 'TP limit must not fill below its limit after slippage');
  const shortTargetTouch = managePaperPosition({ ...position, side: 'SHORT', stopPrice: 102, takeProfit1: 96, takeProfit2: 94 }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 95.8, ask: 96,
  }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(shortTargetTouch.events[0].price, 96, 'SHORT TP limit must not fill above its limit after slippage');
  const shortStop = managePaperPosition({ ...position, side: 'SHORT', stopPrice: 102, takeProfit1: 98, takeProfit2: 94 }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 101.8, ask: 102,
  }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(shortStop.closeReason, 'SL_DIRECT');
  assert.equal(shortStop.exitPrice, 102.1);

  const shortGap = managePaperPosition({ ...position, side: 'SHORT', stopPrice: 102, takeProfit1: 98, takeProfit2: 94 }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 104.3, ask: 104.5,
  }, new Date('2026-09-21T01:00:00.000Z'), explicitCosts);
  assert.equal(shortGap.closeReason, 'SL_DIRECT');
  assert.equal(shortGap.exitPrice, 104.6, 'a SHORT stop gap exits at the observed ask plus adverse slippage, not at the stop');
  assert.equal(shortGap.events[0].stopGapPrice, 2.5);
  assert.equal(shortGap.grossPnl, -92);
});

test('manual paper close uses the correct executable quote side and records a distinct exit reason', () => {
  const opened = {
    status: 'OPEN', quantityOpenLots: 0.2, quantityInitialLots: 0.2,
    entryPrice: 100, stopPrice: 98, takeProfit1: 104, takeProfit2: 106,
    openedAt: '2026-09-21T00:00:00.000Z', tp1Hit: false,
  };
  const now = new Date('2026-09-21T01:00:00.000Z');
  const longClose = managePaperPosition({ ...opened, side: 'LONG' }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 101, ask: 101.2,
  }, now, explicitCosts, { closeRequested: true });
  assert.equal(longClose.closeReason, 'MANUAL_CLOSE');
  assert.equal(longClose.exitPrice, 100.9);
  assert.equal(longClose.quantityOpenLots, 0);
  assert.equal(longClose.grossPnl, 18);
  assert.equal(longClose.commission, 0.4);

  const shortClose = managePaperPosition({ ...opened, side: 'SHORT' }, {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 98.8, ask: 99,
  }, now, explicitCosts, { closeRequested: true });
  assert.equal(shortClose.closeReason, 'MANUAL_CLOSE');
  assert.equal(shortClose.exitPrice, 99.1);
  assert.equal(shortClose.grossPnl, 18);
});
