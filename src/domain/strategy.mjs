import { calculateIndicators } from './indicators.mjs';

export const TIMEFRAMES = Object.freeze(['H4', 'H1', 'M30', 'M15']);
const TIMEFRAME_MS = Object.freeze({ M15: 15 * 60_000, M30: 30 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000 });
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export const DEFAULT_STRATEGY_PARAMETERS = Object.freeze({
  minimumCandlesPerTimeframe: 100,
  timeframeWeights: Object.freeze({ H4: 0.35, H1: 0.30, M30: 0.20, M15: 0.15 }),
  voting: Object.freeze({
    minimumEvaluableVotes: 4,
    minimumDirectionalVotes: 3,
    rsiLongThreshold: 55,
    rsiShortThreshold: 45,
    adxTrendThreshold: 20,
  }),
  minimumAlignedTimeframes: 3,
  entryPlan: Object.freeze({
    atrStopMultiple: 1.5,
    minimumSpreadDistanceMultiple: 2,
    minimumTickDistanceMultiple: 2,
    takeProfit1R: 2,
    takeProfit2R: 3,
    pendingExpiryMinutes: 120,
  }),
});

export const STRATEGY_PARAMETER_RATIONALE = Object.freeze({
  minimumCandlesPerTimeframe: 'The product brief requires at least 100 closed candles per timeframe to support indicator warm-up; this is a data sufficiency floor, not a performance claim.',
  timeframeWeights: Object.freeze({
    H4: 'Slow higher-timeframe context receives the largest vote weight; this heuristic is versioned and must be evaluated out of sample.',
    H1: 'Higher-timeframe confirmation receives the second-largest vote weight; this heuristic is versioned and must be evaluated out of sample.',
    M30: 'Structure context receives an intermediate vote weight; this heuristic is versioned and must be evaluated out of sample.',
    M15: 'The entry trigger contributes a lower score weight so it cannot outweigh higher-timeframe context; its directional trigger remains mandatory.',
  }),
  voting: Object.freeze({
    minimumEvaluableVotes: 'Require at least four usable indicator votes so missing/warming indicators cannot be silently counted as neutral.',
    minimumDirectionalVotes: 'Require three directional votes before assigning a timeframe direction; this majority rule is a testable heuristic, not profitability evidence.',
    rsiLongThreshold: 'RSI at or above 55 votes LONG; the 45-55 neutral band reduces borderline directional votes and is an unvalidated heuristic.',
    rsiShortThreshold: 'RSI at or below 45 votes SHORT; the 45-55 neutral band reduces borderline directional votes and is an unvalidated heuristic.',
    adxTrendThreshold: 'ADX below 20 does not contribute a directional vote; this conventional strength floor is not evidence of XAUUSD edge.',
  }),
  minimumAlignedTimeframes: 'At least three of the four required timeframes must align, subject to mandatory higher-timeframe and M15-trigger checks from the product brief.',
  entryPlan: Object.freeze({
    atrStopMultiple: 'The stop must extend at least 1.5 ATR beyond the selected structure stop; this conservative baseline is uncalibrated and versioned.',
    minimumSpreadDistanceMultiple: 'Keep a pending entry at least two current spreads from the midpoint to reduce near-market ambiguity; provider execution still requires validation.',
    minimumTickDistanceMultiple: 'Keep a pending entry at least two instrument ticks from the midpoint to avoid a sub-tick/near-touch setup.',
    takeProfit1R: 'The product brief sets TP1 at a minimum of 2R.',
    takeProfit2R: 'The product brief sets TP2 at a minimum of 3R.',
    pendingExpiryMinutes: 'The product brief specifies a 120-minute default pending-order expiry.',
  }),
});

function freezeParameters(parameters) {
  return Object.freeze({
    ...parameters,
    timeframeWeights: Object.freeze({ ...parameters.timeframeWeights }),
    voting: Object.freeze({ ...parameters.voting }),
    entryPlan: Object.freeze({ ...parameters.entryPlan }),
  });
}

export function resolveStrategyParameters(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) {
    throw new TypeError('Strategy parameters must be a plain configuration object.');
  }
  for (const key of ['timeframeWeights', 'voting', 'entryPlan']) {
    if (overrides[key] != null && (typeof overrides[key] !== 'object' || Array.isArray(overrides[key])
      || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides[key])))) {
      throw new TypeError('Nested strategy parameters must be configuration objects.');
    }
  }
  const parameters = {
    ...DEFAULT_STRATEGY_PARAMETERS,
    ...overrides,
    timeframeWeights: { ...DEFAULT_STRATEGY_PARAMETERS.timeframeWeights, ...(overrides.timeframeWeights ?? {}) },
    voting: { ...DEFAULT_STRATEGY_PARAMETERS.voting, ...(overrides.voting ?? {}) },
    entryPlan: { ...DEFAULT_STRATEGY_PARAMETERS.entryPlan, ...(overrides.entryPlan ?? {}) },
  };
  const weightKeys = Object.keys(parameters.timeframeWeights).sort();
  const expectedKeys = [...TIMEFRAMES].sort();
  const weightTotal = Object.values(parameters.timeframeWeights).reduce((sum, value) => sum + value, 0);
  const integerRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const positive = (value) => finiteNumber(value) && value > 0;
  if (!integerRange(parameters.minimumCandlesPerTimeframe, 100, 100_000)
    || weightKeys.length !== expectedKeys.length || weightKeys.some((key, index) => key !== expectedKeys[index])
    || Object.values(parameters.timeframeWeights).some((value) => !positive(value) || value > 1)
    || Math.abs(weightTotal - 1) > 1e-9
    || !integerRange(parameters.voting.minimumEvaluableVotes, 1, 5)
    || !integerRange(parameters.voting.minimumDirectionalVotes, 1, parameters.voting.minimumEvaluableVotes)
    || ![parameters.voting.rsiLongThreshold, parameters.voting.rsiShortThreshold, parameters.voting.adxTrendThreshold]
      .every((value) => finiteNumber(value) && value >= 0 && value <= 100)
    || parameters.voting.rsiLongThreshold <= parameters.voting.rsiShortThreshold
    || !integerRange(parameters.minimumAlignedTimeframes, 3, TIMEFRAMES.length)
    || !positive(parameters.entryPlan.atrStopMultiple)
    || !positive(parameters.entryPlan.minimumSpreadDistanceMultiple)
    || !positive(parameters.entryPlan.minimumTickDistanceMultiple)
    || !finiteNumber(parameters.entryPlan.takeProfit1R) || parameters.entryPlan.takeProfit1R < 2
    || !finiteNumber(parameters.entryPlan.takeProfit2R) || parameters.entryPlan.takeProfit2R < 3
    || parameters.entryPlan.takeProfit2R <= parameters.entryPlan.takeProfit1R
    || !integerRange(parameters.entryPlan.pendingExpiryMinutes, 1, 10_080)) {
    throw new TypeError('Strategy parameters violate the versioned paper-strategy constraints.');
  }
  return freezeParameters(parameters);
}

function candleTime(candle) {
  return Date.parse(candle?.closedAt ?? candle?.closed_at ?? '');
}

function validateCandle(candle) {
  const values = ['open', 'high', 'low', 'close'].map((key) => Number(candle?.[key]));
  if (!values.every(Number.isFinite)) return false;
  const [open, high, low, close] = values;
  return low <= Math.min(open, close) && high >= Math.max(open, close) && high >= low;
}

export function analyzeTimeframe({ candles, timeframe, source, now = new Date(), minCandles, strategyParameters }) {
  const parameters = resolveStrategyParameters(strategyParameters);
  const candleMinimum = minCandles ?? parameters.minimumCandlesPerTimeframe;
  if (!Number.isInteger(candleMinimum) || candleMinimum < 100 || candleMinimum > 100_000) {
    throw new TypeError('Minimum candle count must be an integer from 100 to 100000.');
  }
  const rejectionReasons = [];
  if (!TIMEFRAMES.includes(timeframe)) rejectionReasons.push('TIMEFRAME_UNSUPPORTED');
  if (!Array.isArray(candles) || candles.length < candleMinimum) rejectionReasons.push('INSUFFICIENT_CANDLES');
  if (!Array.isArray(candles) || candles.some((candle) => !validateCandle(candle))) rejectionReasons.push('CANDLE_INVALID');
  if (Array.isArray(candles)) {
    if (candles.some((candle) => candle.quality != null && candle.quality !== 'VERIFIED_CLOSED')) rejectionReasons.push('CANDLE_QUALITY_REJECTED');
    const times = candles.map(candleTime);
    if (times.some((value) => !Number.isFinite(value))) rejectionReasons.push('CANDLE_TIMESTAMP_INVALID');
    if (times.some((value, index) => index > 0 && value <= times[index - 1])) rejectionReasons.push('CANDLE_ORDER_INVALID');
    const latest = times.at(-1);
    if (Number.isFinite(latest) && latest > now.getTime()) rejectionReasons.push('LOOKAHEAD_CANDLE');
    if (Number.isFinite(latest) && timeframe in TIMEFRAME_MS && now.getTime() - latest > Math.max(TIMEFRAME_MS[timeframe] * 2, 30 * 60_000)) rejectionReasons.push('DATA_STALE');
    if (times.length > 1 && timeframe in TIMEFRAME_MS) {
      const recent = times.slice(-10);
      const suspiciousGap = recent.some((value, index) => index > 0 && value - recent[index - 1] > TIMEFRAME_MS[timeframe] * 3 && value - recent[index - 1] < 48 * 60 * 60_000);
      if (suspiciousGap) rejectionReasons.push('CANDLE_GAP');
    }
  }
  const sources = new Set((candles ?? []).map((candle) => String(candle.source ?? source ?? '').toUpperCase()));
  if (String(source ?? '').toUpperCase() !== 'BROKER' || [...sources].some((item) => item !== 'BROKER')) rejectionReasons.push('MARKET_SOURCE_NOT_VERIFIED_BROKER');

  if (rejectionReasons.length) {
    return { timeframe, direction: 'UNAVAILABLE', strength: null, votes: [], indicators: null, fresh: false, candleClosedAt: candles?.at(-1)?.closedAt ?? candles?.at(-1)?.closed_at ?? null, rejectionReasons: [...new Set(rejectionReasons)] };
  }

  const indicators = calculateIndicators(candles);
  const close = Number(candles.at(-1).close);
  const votes = [];
  const pushVote = (name, direction, evidence) => votes.push({ indicator: name, direction, evidence });

  if ([indicators.ema9, indicators.ema21, indicators.ema50].every(finite)) {
    pushVote('EMA_ALIGNMENT', indicators.ema9 > indicators.ema21 && indicators.ema21 > indicators.ema50 && close > indicators.ema50
      ? 'LONG' : indicators.ema9 < indicators.ema21 && indicators.ema21 < indicators.ema50 && close < indicators.ema50 ? 'SHORT' : 'NEUTRAL',
    { ema9: indicators.ema9, ema21: indicators.ema21, ema50: indicators.ema50, close });
  }
  if (finite(indicators.macd.histogram)) pushVote('MACD_HISTOGRAM', indicators.macd.histogram > 0 ? 'LONG' : indicators.macd.histogram < 0 ? 'SHORT' : 'NEUTRAL', { value: indicators.macd.histogram });
  if (finite(indicators.rsi14)) pushVote('RSI_14', indicators.rsi14 >= parameters.voting.rsiLongThreshold ? 'LONG'
    : indicators.rsi14 <= parameters.voting.rsiShortThreshold ? 'SHORT' : 'NEUTRAL', { value: indicators.rsi14 });
  if (finite(indicators.supertrend.direction)) pushVote('SUPERTREND', indicators.supertrend.direction > 0 ? 'LONG' : 'SHORT', { value: indicators.supertrend.value });
  if (finite(indicators.adx14.value) && indicators.adx14.value >= parameters.voting.adxTrendThreshold && finite(indicators.adx14.plusDi) && finite(indicators.adx14.minusDi)) {
    pushVote('ADX_DIRECTIONAL_MOVEMENT', indicators.adx14.plusDi > indicators.adx14.minusDi ? 'LONG' : indicators.adx14.minusDi > indicators.adx14.plusDi ? 'SHORT' : 'NEUTRAL', indicators.adx14);
  }
  if (votes.length < parameters.voting.minimumEvaluableVotes) rejectionReasons.push('INDICATORS_WARMING_UP');

  const longVotes = votes.filter((vote) => vote.direction === 'LONG').length;
  const shortVotes = votes.filter((vote) => vote.direction === 'SHORT').length;
  const direction = longVotes >= parameters.voting.minimumDirectionalVotes && longVotes > shortVotes ? 'LONG'
    : shortVotes >= parameters.voting.minimumDirectionalVotes && shortVotes > longVotes ? 'SHORT' : 'NEUTRAL';
  const strength = votes.length ? Math.round(Math.max(longVotes, shortVotes) / votes.length * 100) : null;
  return {
    timeframe,
    direction,
    strength,
    votes,
    indicators,
    fresh: rejectionReasons.length === 0,
    candleClosedAt: candles.at(-1).closedAt ?? candles.at(-1).closed_at,
    rejectionReasons,
  };
}

function alignedScore(analyses, direction, timeframeWeights) {
  return Math.round(TIMEFRAMES.reduce((sum, timeframe) => {
    const analysis = analyses.find((item) => item.timeframe === timeframe);
    return sum + (analysis?.direction === direction && finite(analysis.strength) ? timeframeWeights[timeframe] * Number(analysis.strength) : 0);
  }, 0));
}

export function buildEntryPlan({ direction, quote, atr14, support, resistance, ema21, swingLow, swingHigh, instrument, strategyParameters }) {
  const parameters = resolveStrategyParameters(strategyParameters);
  const reasons = [];
  if (!['LONG', 'SHORT'].includes(direction)) reasons.push('DIRECTION_INVALID');
  if (!quote || !finite(quote.bid) || !finite(quote.ask) || Number(quote.ask) < Number(quote.bid)) reasons.push('QUOTE_INVALID');
  if (!finite(atr14) || Number(atr14) <= 0) reasons.push('ATR_UNAVAILABLE');
  if (!instrument || !finite(instrument.tickSize) || Number(instrument.tickSize) <= 0
    || !finite(instrument.minStopDistance) || Number(instrument.minStopDistance) < 0
    || !Number.isInteger(instrument.digits) || instrument.digits < 0 || instrument.digits > 10) reasons.push('INSTRUMENT_METADATA_INCOMPLETE');
  if (reasons.length) return { allowed: false, reasons, plan: null };

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const spread = ask - bid;
  const current = (ask + bid) / 2;
  const tick = Number(instrument.tickSize);
  const minDistance = Math.max(Number(instrument.minStopDistance),
    spread * parameters.entryPlan.minimumSpreadDistanceMultiple,
    tick * parameters.entryPlan.minimumTickDistanceMultiple);
  const candidates = direction === 'LONG' ? [support, ema21] : [resistance, ema21];
  const levels = candidates.filter((value) => finite(value) && (direction === 'LONG' ? Number(value) < current : Number(value) > current));
  if (!levels.length) return { allowed: false, reasons: ['NO_VALID_PULLBACK_LEVEL'], plan: null };
  const entryLevel = direction === 'LONG' ? Math.max(...levels.map(Number)) : Math.min(...levels.map(Number));
  let entry = direction === 'LONG' ? Math.min(entryLevel, bid - minDistance) : Math.max(entryLevel, ask + minDistance);
  entry = roundToTick(entry, tick, direction === 'LONG' ? 'down' : 'up');
  if (Math.abs(current - entry) < minDistance) return { allowed: false, reasons: ['ENTRY_TOO_CLOSE_TO_MARKET'], plan: null };

  const atrStopDistance = Number(atr14) * parameters.entryPlan.atrStopMultiple;
  let stop;
  if (direction === 'LONG') {
    const structureStop = finite(swingLow) && Number(swingLow) < entry ? Number(swingLow) : entry - atrStopDistance;
    stop = Math.min(structureStop, entry - atrStopDistance);
    stop = roundToTick(stop, tick, 'down');
  } else {
    const structureStop = finite(swingHigh) && Number(swingHigh) > entry ? Number(swingHigh) : entry + atrStopDistance;
    stop = Math.max(structureStop, entry + atrStopDistance);
    stop = roundToTick(stop, tick, 'up');
  }
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance < Number(instrument.minStopDistance) || riskDistance <= 0) return { allowed: false, reasons: ['STOP_DISTANCE_INVALID'], plan: null };
  const target1 = roundToTick(direction === 'LONG' ? entry + parameters.entryPlan.takeProfit1R * riskDistance
    : entry - parameters.entryPlan.takeProfit1R * riskDistance, tick, direction === 'LONG' ? 'up' : 'down');
  const target2 = roundToTick(direction === 'LONG' ? entry + parameters.entryPlan.takeProfit2R * riskDistance
    : entry - parameters.entryPlan.takeProfit2R * riskDistance, tick, direction === 'LONG' ? 'up' : 'down');
  const rewardDistance = Math.abs(target1 - entry);
  const rr = rewardDistance / riskDistance;
  return {
    allowed: rr >= 2,
    reasons: rr >= 2 ? [] : ['RR_BELOW_MINIMUM'],
    plan: {
      direction,
      orderType: 'LIMIT',
      entry,
      stop,
      takeProfit1: target1,
      takeProfit2: target2,
      riskDistance,
      riskReward: rr,
      spread,
      expiresAfterMinutes: parameters.entryPlan.pendingExpiryMinutes,
      priceDigits: instrument.digits,
    },
  };
}

export function roundToTick(value, tickSize, mode = 'nearest') {
  if (!finite(value) || !finite(tickSize) || Number(tickSize) <= 0) throw new TypeError('A finite value and positive tick size are required.');
  const scaled = Number(value) / Number(tickSize);
  const ticks = mode === 'down' ? Math.floor(scaled + 1e-10) : mode === 'up' ? Math.ceil(scaled - 1e-10) : Math.round(scaled);
  const precision = Math.min(10, Math.max(0, Math.ceil(-Math.log10(Number(tickSize)) + 2)));
  return Number((ticks * Number(tickSize)).toFixed(precision));
}

export function evaluateMtfGate({ analyses, quote, news, risk, plan, config }) {
  const parameters = resolveStrategyParameters(config?.strategyParameters);
  const rejectionReasons = [];
  const items = Array.isArray(analyses) ? analyses : [];
  const complete = TIMEFRAMES.every((timeframe) => items.some((item) => item.timeframe === timeframe && item.fresh && ['LONG', 'SHORT', 'NEUTRAL'].includes(item.direction)));
  if (!complete) rejectionReasons.push('MTF_DATA_INCOMPLETE_OR_STALE');
  const m15ClosedAt = Date.parse(items.find((item) => item.timeframe === 'M15')?.candleClosedAt ?? '');
  const timeframesAligned = Number.isFinite(m15ClosedAt) && TIMEFRAMES.every((timeframe) => {
    const analysis = items.find((item) => item.timeframe === timeframe);
    const closedAt = Date.parse(analysis?.candleClosedAt ?? '');
    const age = m15ClosedAt - closedAt;
    return Number.isFinite(closedAt) && age >= 0 && age < TIMEFRAME_MS[timeframe];
  });
  if (!timeframesAligned) rejectionReasons.push('MTF_TIMEFRAME_ALIGNMENT_INVALID');

  const longCount = items.filter((item) => item.direction === 'LONG' && item.fresh).length;
  const shortCount = items.filter((item) => item.direction === 'SHORT' && item.fresh).length;
  const direction = longCount === shortCount ? 'NEUTRAL' : longCount > shortCount ? 'LONG' : 'SHORT';
  const aligned = direction === 'LONG' ? longCount : direction === 'SHORT' ? shortCount : 0;
  const confluencePct = aligned / TIMEFRAMES.length * 100;
  const score = direction === 'NEUTRAL' ? 0 : alignedScore(items, direction, parameters.timeframeWeights);
  if (aligned < parameters.minimumAlignedTimeframes) rejectionReasons.push('MTF_ALIGNMENT_BELOW_MINIMUM');
  const byTimeframe = Object.fromEntries(items.map((item) => [item.timeframe, item]));
  if (['LONG', 'SHORT'].includes(direction) && ['H4', 'H1'].some((timeframe) => byTimeframe[timeframe]?.direction && byTimeframe[timeframe].direction !== 'NEUTRAL' && byTimeframe[timeframe].direction !== direction)) rejectionReasons.push('HIGHER_TIMEFRAME_CONFLICT');
  if (['LONG', 'SHORT'].includes(direction) && byTimeframe.M30?.direction && !['NEUTRAL', direction].includes(byTimeframe.M30.direction)) rejectionReasons.push('M30_STRUCTURE_CONFLICT');
  if (!['LONG', 'SHORT'].includes(direction) || byTimeframe.M15?.direction !== direction) rejectionReasons.push('M15_TRIGGER_MISSING');
  if (confluencePct < Number(config?.minConfluencePct ?? 60)) rejectionReasons.push('CONFLUENCE_BELOW_MINIMUM');
  if (score < Number(config?.minSignalScore ?? 70)) rejectionReasons.push('SCORE_BELOW_MINIMUM');

  if (!quote || String(quote.source ?? '').toUpperCase() !== 'BROKER') rejectionReasons.push('BROKER_OFFLINE');
  if (quote && quote.dataFreshness !== 'FRESH') rejectionReasons.push('MARKET_DATA_STALE');
  if (!quote || !finite(quote.bid) || !finite(quote.ask) || Number(quote.ask) < Number(quote.bid)) rejectionReasons.push('QUOTE_INVALID');
  if (!finite(config?.maxSpreadPrice) || Number(config.maxSpreadPrice) <= 0) rejectionReasons.push('SPREAD_LIMIT_UNCONFIGURED');
  else if (quote && finite(quote.bid) && finite(quote.ask) && Number(quote.ask) - Number(quote.bid) > Number(config.maxSpreadPrice)) rejectionReasons.push('SPREAD_TOO_WIDE');
  if (news?.allowed !== true) rejectionReasons.push(...(Array.isArray(news?.reasons) && news.reasons.length ? news.reasons : ['NEWS_STATE_UNKNOWN']));
  if (risk?.allowed !== true) rejectionReasons.push(...(Array.isArray(risk?.reasons) && risk.reasons.length ? risk.reasons : ['RISK_GUARD_BLOCKED']));
  if (!plan?.allowed || !plan?.plan) rejectionReasons.push(...(Array.isArray(plan?.reasons) && plan.reasons.length ? plan.reasons : ['ENTRY_PLAN_INVALID']));
  if (plan?.plan && Number(plan.plan.riskReward) < Number(config?.minRiskReward ?? 2)) rejectionReasons.push('RR_BELOW_MINIMUM');

  const uniqueReasons = [...new Set(rejectionReasons)];
  return {
    status: uniqueReasons.length ? uniqueReasons.includes('M15_TRIGGER_MISSING') ? 'WAITING' : 'REJECTED' : 'READY',
    accepted: uniqueReasons.length === 0,
    direction,
    alignedTimeframes: aligned,
    confluencePct,
    score,
    weights: parameters.timeframeWeights,
    reasons: uniqueReasons,
  };
}
