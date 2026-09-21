const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const valueOf = (candle, key) => {
  if (candle?.[key] == null || candle[key] === '') return null;
  const value = Number(candle?.[key]);
  return Number.isFinite(value) ? value : null;
};

export function ema(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1) throw new TypeError('EMA requires a value series and a positive integer period.');
  const result = Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let warmup = [];
  let current = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) {
      warmup = [];
      current = null;
      continue;
    }
    const numeric = Number(value);
    if (current == null) {
      warmup.push(numeric);
      if (warmup.length === period) {
        current = warmup.reduce((sum, item) => sum + item, 0) / period;
        result[index] = current;
      }
      continue;
    }
    current += alpha * (numeric - current);
    result[index] = current;
  }
  return result;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1) throw new TypeError('RSI requires a value series and a positive integer period.');
  const result = Array(values.length).fill(null);
  let changes = [];
  let averageGain = null;
  let averageLoss = null;
  const toRsi = (g, l) => l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  for (let index = 1; index < values.length; index += 1) {
    if (!finite(values[index]) || !finite(values[index - 1])) {
      changes = [];
      averageGain = null;
      averageLoss = null;
      continue;
    }
    const change = Number(values[index]) - Number(values[index - 1]);
    if (averageGain == null || averageLoss == null) {
      changes.push({ gain: Math.max(0, change), loss: Math.max(0, -change) });
      if (changes.length < period) continue;
      averageGain = changes.reduce((sum, item) => sum + item.gain, 0) / period;
      averageLoss = changes.reduce((sum, item) => sum + item.loss, 0) / period;
      changes = [];
    } else {
      averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
      averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    }
    result[index] = toRsi(averageGain, averageLoss);
  }
  return result;
}

export function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!(fastPeriod > 0 && slowPeriod > fastPeriod && signalPeriod > 0)) throw new TypeError('MACD periods are invalid.');
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = values.map((_, index) => fast[index] == null || slow[index] == null ? null : fast[index] - slow[index]);
  const signal = ema(line, signalPeriod);
  const histogram = line.map((value, index) => value == null || signal[index] == null ? null : value - signal[index]);
  return { line, signal, histogram };
}

export function trueRange(candles) {
  return candles.map((candle, index) => {
    const high = valueOf(candle, 'high');
    const low = valueOf(candle, 'low');
    const previousClose = index === 0 ? null : valueOf(candles[index - 1], 'close');
    if (high == null || low == null || low > high) return null;
    if (previousClose == null) return high - low;
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
}

export function atr(candles, period = 14) {
  const ranges = trueRange(candles);
  if (!Number.isInteger(period) || period < 1) throw new TypeError('ATR period must be a positive integer.');
  const result = Array(candles.length).fill(null);
  if (ranges.length < period) return result;
  let seed = 0;
  for (let index = 0; index < period; index += 1) {
    if (!finite(ranges[index])) return result;
    seed += ranges[index];
  }
  let current = seed / period;
  result[period - 1] = current;
  for (let index = period; index < ranges.length; index += 1) {
    if (!finite(ranges[index])) {
      current = null;
      continue;
    }
    if (current == null) {
      const start = index - period + 1;
      const window = ranges.slice(start, index + 1);
      if (window.every(finite)) current = window.reduce((sum, item) => sum + item, 0) / period;
    } else {
      current = (current * (period - 1) + ranges[index]) / period;
    }
    result[index] = current;
  }
  return result;
}

export function adx(candles, period = 14) {
  if (!Number.isInteger(period) || period < 1) throw new TypeError('ADX period must be a positive integer.');
  const length = candles.length;
  const plusDi = Array(length).fill(null);
  const minusDi = Array(length).fill(null);
  const dx = Array(length).fill(null);
  const result = Array(length).fill(null);
  if (length <= period * 2) return { adx: result, plusDi, minusDi };
  const ranges = trueRange(candles);
  const plusMoves = Array(length).fill(0);
  const minusMoves = Array(length).fill(0);
  for (let index = 1; index < length; index += 1) {
    const high = valueOf(candles[index], 'high');
    const low = valueOf(candles[index], 'low');
    const previousHigh = valueOf(candles[index - 1], 'high');
    const previousLow = valueOf(candles[index - 1], 'low');
    if ([high, low, previousHigh, previousLow].some((value) => value == null)) continue;
    const up = high - previousHigh;
    const down = previousLow - low;
    plusMoves[index] = up > down && up > 0 ? up : 0;
    minusMoves[index] = down > up && down > 0 ? down : 0;
  }

  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let index = 1; index <= period; index += 1) {
    if (![ranges[index], plusMoves[index], minusMoves[index]].every(finite)) return { adx: result, plusDi, minusDi };
    smoothTr += ranges[index];
    smoothPlus += plusMoves[index];
    smoothMinus += minusMoves[index];
  }

  const setDirectional = (index) => {
    plusDi[index] = smoothTr === 0 ? 0 : 100 * smoothPlus / smoothTr;
    minusDi[index] = smoothTr === 0 ? 0 : 100 * smoothMinus / smoothTr;
    const denominator = plusDi[index] + minusDi[index];
    dx[index] = denominator === 0 ? 0 : 100 * Math.abs(plusDi[index] - minusDi[index]) / denominator;
  };
  setDirectional(period);
  for (let index = period + 1; index < length; index += 1) {
    if (![ranges[index], plusMoves[index], minusMoves[index]].every(finite)) continue;
    smoothTr = smoothTr - smoothTr / period + ranges[index];
    smoothPlus = smoothPlus - smoothPlus / period + plusMoves[index];
    smoothMinus = smoothMinus - smoothMinus / period + minusMoves[index];
    setDirectional(index);
  }

  const firstAdxIndex = period * 2 - 1;
  const seedDx = dx.slice(period, firstAdxIndex + 1);
  if (seedDx.length === period && seedDx.every(finite)) {
    result[firstAdxIndex] = seedDx.reduce((sum, item) => sum + item, 0) / period;
    for (let index = firstAdxIndex + 1; index < length; index += 1) {
      if (finite(dx[index])) result[index] = (result[index - 1] * (period - 1) + dx[index]) / period;
    }
  }
  return { adx: result, plusDi, minusDi };
}

export function stochRsi(values, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const rsiValues = rsi(values, rsiPeriod);
  const raw = Array(values.length).fill(null);
  for (let index = 0; index < values.length; index += 1) {
    const window = rsiValues.slice(Math.max(0, index - stochPeriod + 1), index + 1);
    if (window.length !== stochPeriod || !window.every(finite)) continue;
    const low = Math.min(...window);
    const high = Math.max(...window);
    raw[index] = high === low ? null : 100 * (rsiValues[index] - low) / (high - low);
  }
  const k = Array(values.length).fill(null);
  for (let index = smoothK - 1; index < raw.length; index += 1) {
    const window = raw.slice(index - smoothK + 1, index + 1);
    if (window.every(finite)) k[index] = window.reduce((sum, value) => sum + value, 0) / smoothK;
  }
  const d = Array(values.length).fill(null);
  for (let index = smoothD - 1; index < k.length; index += 1) {
    const window = k.slice(index - smoothD + 1, index + 1);
    if (window.every(finite)) d[index] = window.reduce((sum, value) => sum + value, 0) / smoothD;
  }
  return { rsi: rsiValues, raw, k, d };
}

export function supertrend(candles, period = 10, multiplier = 3) {
  const ranges = atr(candles, period);
  const line = Array(candles.length).fill(null);
  const direction = Array(candles.length).fill(null);
  let finalUpper = null;
  let finalLower = null;
  for (let index = 0; index < candles.length; index += 1) {
    const high = valueOf(candles[index], 'high');
    const low = valueOf(candles[index], 'low');
    const close = valueOf(candles[index], 'close');
    if (ranges[index] == null || [high, low, close].some((value) => value == null)) continue;
    const middle = (high + low) / 2;
    const basicUpper = middle + multiplier * ranges[index];
    const basicLower = middle - multiplier * ranges[index];
    if (finalUpper == null || finalLower == null) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction[index] = close >= middle ? 1 : -1;
    } else {
      const priorClose = valueOf(candles[index - 1], 'close');
      finalUpper = basicUpper < finalUpper || priorClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || priorClose < finalLower ? basicLower : finalLower;
      const previousDirection = direction[index - 1] ?? 1;
      direction[index] = previousDirection === 1
        ? (close < finalLower ? -1 : 1)
        : (close > finalUpper ? 1 : -1);
    }
    line[index] = direction[index] === 1 ? finalLower : finalUpper;
  }
  return { line, direction };
}

export function swingPoints(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const high = valueOf(candles[index], 'high');
    const low = valueOf(candles[index], 'low');
    if (high == null || low == null) continue;
    const highWindow = candles.slice(index - left, index + right + 1).map((candle) => valueOf(candle, 'high'));
    const lowWindow = candles.slice(index - left, index + right + 1).map((candle) => valueOf(candle, 'low'));
    if (highWindow.every(finite) && high === Math.max(...highWindow) && highWindow.indexOf(high) === left) highs.push({ index, price: high });
    if (lowWindow.every(finite) && low === Math.min(...lowWindow) && lowWindow.indexOf(low) === left) lows.push({ index, price: low });
  }
  return { highs, lows };
}

export function supportResistance(candles, lookback = 100) {
  const selected = candles.slice(-lookback);
  const close = valueOf(selected.at(-1), 'close');
  if (close == null) return { support: null, resistance: null };
  const swings = swingPoints(selected);
  const below = swings.lows.map((point) => point.price).filter((value) => value <= close);
  const above = swings.highs.map((point) => point.price).filter((value) => value >= close);
  return {
    support: below.length ? Math.max(...below) : null,
    resistance: above.length ? Math.min(...above) : null,
  };
}

export function candlePattern(candles) {
  if (candles.length < 2) return 'UNAVAILABLE';
  const current = candles.at(-1);
  const prior = candles.at(-2);
  const open = valueOf(current, 'open');
  const close = valueOf(current, 'close');
  const high = valueOf(current, 'high');
  const low = valueOf(current, 'low');
  const priorOpen = valueOf(prior, 'open');
  const priorClose = valueOf(prior, 'close');
  if ([open, close, high, low, priorOpen, priorClose].some((value) => value == null)) return 'UNAVAILABLE';
  const body = Math.abs(close - open);
  const range = high - low;
  if (range <= 0) return 'INVALID_CANDLE';
  if (body / range <= 0.1) return 'DOJI';
  if (priorClose < priorOpen && close > open && close >= priorOpen && open <= priorClose) return 'BULLISH_ENGULFING';
  if (priorClose > priorOpen && close < open && open >= priorClose && close <= priorOpen) return 'BEARISH_ENGULFING';
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  if (lowerWick >= body * 2 && upperWick <= body) return 'HAMMER';
  if (upperWick >= body * 2 && lowerWick <= body) return 'SHOOTING_STAR';
  return 'NONE';
}

export function tickVolumeRatio(candles, period = 20) {
  const window = candles.slice(-period);
  if (window.length < period || window.some((candle) => !Number.isInteger(candle.tickVolume) || candle.tickVolume < 0)) {
    return { value: null, status: 'UNAVAILABLE' };
  }
  const baseline = window.slice(0, -1).map((candle) => candle.tickVolume);
  const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
  if (mean === 0) return { value: null, status: 'UNAVAILABLE' };
  return { value: window.at(-1).tickVolume / mean, status: 'AVAILABLE' };
}

export function calculateIndicators(candles) {
  const closes = candles.map((candle) => valueOf(candle, 'close'));
  const macdValues = macd(closes, 12, 26, 9);
  const atrValues = atr(candles, 14);
  const adxValues = adx(candles, 14);
  const stochastic = stochRsi(closes, 14, 14, 3, 3);
  const trend = supertrend(candles, 10, 3);
  const swings = swingPoints(candles);
  return {
    ema9: ema(closes, 9).at(-1),
    ema21: ema(closes, 21).at(-1),
    ema50: ema(closes, 50).at(-1),
    rsi14: rsi(closes, 14).at(-1),
    macd: { line: macdValues.line.at(-1), signal: macdValues.signal.at(-1), histogram: macdValues.histogram.at(-1) },
    atr14: atrValues.at(-1),
    adx14: { value: adxValues.adx.at(-1), plusDi: adxValues.plusDi.at(-1), minusDi: adxValues.minusDi.at(-1) },
    stochRsi: { k: stochastic.k.at(-1), d: stochastic.d.at(-1) },
    supertrend: { value: trend.line.at(-1), direction: trend.direction.at(-1) },
    supportResistance: supportResistance(candles),
    swingHigh: swings.highs.at(-1)?.price ?? null,
    swingLow: swings.lows.at(-1)?.price ?? null,
    candlePattern: candlePattern(candles),
    tickVolumeRatio: tickVolumeRatio(candles),
  };
}
