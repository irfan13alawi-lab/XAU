const MINIMUM_INTERPRETATION_SAMPLE = 30;
const Z_95 = 1.959963984540054;
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const numeric = (value) => finite(value) ? Number(value) : null;

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function wilsonWinRate95(successes, sampleCount) {
  if (sampleCount < MINIMUM_INTERPRETATION_SAMPLE) return null;
  const proportion = successes / sampleCount;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / sampleCount;
  const center = (proportion + zSquared / (2 * sampleCount)) / denominator;
  const halfWidth = Z_95 * Math.sqrt(proportion * (1 - proportion) / sampleCount
    + zSquared / (4 * sampleCount ** 2)) / denominator;
  return {
    lowerPct: Number(((center - halfWidth) * 100).toFixed(4)),
    upperPct: Number(((center + halfWidth) * 100).toFixed(4)),
    method: 'WILSON_SCORE_95',
  };
}

function tCritical95Approx(degreesOfFreedom) {
  const z = Z_95;
  const v = degreesOfFreedom;
  return z
    + (z ** 3 + z) / (4 * v)
    + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3);
}

function expectancyR95(values) {
  if (values.length < MINIMUM_INTERPRETATION_SAMPLE) return null;
  const mean = average(values);
  const sumSquares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const sampleDeviation = Math.sqrt(sumSquares / (values.length - 1));
  const halfWidth = tCritical95Approx(values.length - 1) * sampleDeviation / Math.sqrt(values.length);
  return {
    lower: Number((mean - halfWidth).toFixed(6)),
    upper: Number((mean + halfWidth).toFixed(6)),
    method: 'STUDENT_T_CORNISH_FISHER_APPROX_95',
  };
}

function coreMetrics(rows) {
  const pnl = rows.map((row) => numeric(row.netPnl)).filter((value) => value != null);
  const pnlR = rows.map((row) => numeric(row.pnlR)).filter((value) => value != null);
  const wins = rows.filter((row) => numeric(row.netPnl) > 0);
  const losses = rows.filter((row) => numeric(row.netPnl) < 0);
  const grossWins = wins.reduce((sum, row) => sum + numeric(row.netPnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + numeric(row.netPnl), 0));
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const row of rows) {
    const value = numeric(row.pnlR);
    if (value == null) continue;
    equityR += value;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  }
  const delay = rows.map((row) => numeric(row.entryDelaySeconds)).filter((value) => value != null);
  const duration = rows.map((row) => numeric(row.durationSeconds)).filter((value) => value != null);
  const mfe = rows.map((row) => numeric(row.mfe)).filter((value) => value != null);
  const mae = rows.map((row) => numeric(row.mae)).filter((value) => value != null);
  return {
    winRatePct: pnl.length ? wins.length / pnl.length * 100 : null,
    winRateSampleCount: pnl.length,
    winRate95CiPct: wilsonWinRate95(wins.length, pnl.length),
    profitFactor: grossLoss > 0 ? grossWins / grossLoss : null,
    expectancyR: average(pnlR),
    expectancyRSampleCount: pnlR.length,
    expectancyR95Ci: expectancyR95(pnlR),
    netR: pnlR.length ? pnlR.reduce((sum, value) => sum + value, 0) : null,
    netPnl: pnl.length ? pnl.reduce((sum, value) => sum + value, 0) : null,
    averageWin: average(wins.map((row) => numeric(row.netPnl)).filter((value) => value != null)),
    averageLoss: average(losses.map((row) => numeric(row.netPnl)).filter((value) => value != null)),
    averageWinR: average(wins.map((row) => numeric(row.pnlR)).filter((value) => value != null)),
    averageLossR: average(losses.map((row) => numeric(row.pnlR)).filter((value) => value != null)),
    maxDrawdownR,
    averageFillDelaySeconds: average(delay),
    fillDelaySampleCount: delay.length,
    averageDurationSeconds: average(duration),
    averageMfePrice: average(mfe),
    averageMaePrice: average(mae),
    tp1HitCount: rows.filter((row) => row.tp1Hit === true).length,
    tp2CloseCount: rows.filter((row) => row.closeReason === 'HIT_TP2').length,
    directSlCount: rows.filter((row) => row.closeReason === 'SL_DIRECT').length,
    protectedAfterTp1Count: rows.filter((row) => row.closeReason === 'SL_AFTER_TP1').length,
  };
}

function sampleSummary(rows) {
  const currencies = [...new Set(rows.map((row) => row.currency).filter((value) => typeof value === 'string' && value))];
  const currencySafe = currencies.length === 1;
  const sufficientSample = rows.length >= MINIMUM_INTERPRETATION_SAMPLE;
  return {
    sampleCount: rows.length,
    sufficientSample,
    metrics: sufficientSample && currencySafe ? coreMetrics(rows) : null,
    metricsSuppressedReason: sufficientSample && !currencySafe
      ? currencies.length ? 'MIXED_ACCOUNT_CURRENCIES' : 'ACCOUNT_CURRENCY_UNAVAILABLE'
      : null,
  };
}

function slices(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const selected = selector(row);
    const keys = [...new Set((Array.isArray(selected) ? selected : [selected]).filter((item) => typeof item === 'string' && item.length))];
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, items]) => [key, sampleSummary(items)]));
}

function periodMetrics(rows, now, currencySafe) {
  const today = now.toISOString().slice(0, 10);
  const weekStart = now.getTime() - 7 * 24 * 60 * 60_000;
  const closedBy = (row) => Date.parse(row.closedAt ?? '') <= now.getTime();
  const todayRows = rows.filter((row) => closedBy(row) && String(row.closedAt).slice(0, 10) === today);
  const weekRows = rows.filter((row) => closedBy(row) && Date.parse(row.closedAt) >= weekStart);
  const net = (items) => items.length && currencySafe ? items.reduce((sum, row) => sum + (numeric(row.netPnl) ?? 0), 0) : null;
  const lossR = (items) => items.reduce((sum, row) => sum + Math.max(0, -(numeric(row.pnlR) ?? 0)), 0);
  return {
    today: { sampleCount: todayRows.length, realizedNetPnl: net(todayRows), realizedLossR: lossR(todayRows) },
    trailing7Days: { sampleCount: weekRows.length, realizedNetPnl: net(weekRows), realizedLossR: lossR(weekRows) },
  };
}

export function aggregateTradeStatistics(rows, { now = new Date(), pendingExpiredCount = 0 } = {}) {
  if (!Array.isArray(rows) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Statistics require trade rows and a valid clock value.');
  }
  const currencies = [...new Set(rows.map((row) => row.currency).filter((value) => typeof value === 'string' && value))];
  const sufficientSample = rows.length >= MINIMUM_INTERPRETATION_SAMPLE;
  const currencySafe = currencies.length === 1;
  const metrics = sufficientSample && currencySafe ? coreMetrics(rows) : null;
  const marketTag = (row, name) => (row.marketConditions ?? []).find((tag) => tag === name);
  const sessionTags = (row) => (row.marketConditions ?? []).filter((tag) => tag.startsWith('SESSION_'));
  const newsTag = (row) => (row.setupQuality ?? []).some((tag) => tag === 'NEWS_CLEAR') ? 'NEWS_CLEAR' : 'NEWS_UNKNOWN';
  const spreadBucket = (row) => {
    if (!finite(row.spreadAtrRatio) || Number(row.spreadAtrRatio) < 0) return 'UNAVAILABLE';
    // Descriptive cohort boundaries, not strategy or execution gates.
    return Number(row.spreadAtrRatio) <= 0.05 ? 'LOW_<=0.05' : Number(row.spreadAtrRatio) <= 0.1 ? 'MID_0.05_TO_0.10' : 'HIGH_>0.10';
  };
  return {
    sampleCount: rows.length,
    minimumInterpretationSample: MINIMUM_INTERPRETATION_SAMPLE,
    sufficientSample,
    interpretation: !sufficientSample ? 'NO_PERFORMANCE_CONCLUSION_SAMPLE_BELOW_30'
      : currencySafe ? 'PAPER_HISTORY_ONLY_NOT_PROFITABILITY_EVIDENCE' : 'NO_COMPARABLE_CURRENCY_CONTEXT',
    metricsSuppressedReason: sufficientSample && !currencySafe
      ? currencies.length ? 'MIXED_ACCOUNT_CURRENCIES' : 'ACCOUNT_CURRENCY_UNAVAILABLE'
      : null,
    uncertainty: {
      intervalsRequireAtLeast: MINIMUM_INTERPRETATION_SAMPLE,
      methods: {
        winRate: 'Wilson score 95% interval',
        expectancyR: 'Approximate Student-t 95% interval using Cornish-Fisher expansion',
      },
      limitation: 'Descriptive intervals assume independent trade observations; serial dependence, selection bias, data authenticity, and future outcomes are not modeled.',
    },
    currency: currencies.length === 1 ? currencies[0] : null,
    metrics,
    periods: periodMetrics(rows, now, currencySafe),
    pendingExpiredCount: Number.isInteger(pendingExpiredCount) && pendingExpiredCount >= 0 ? pendingExpiredCount : 0,
    slices: {
      side: slices(rows, (row) => row.side ?? 'UNAVAILABLE'),
      exitResult: slices(rows, (row) => row.closeReason ?? 'UNAVAILABLE'),
      setupQuality: slices(rows, (row) => row.setupQuality?.length ? row.setupQuality : ['UNAVAILABLE']),
      timeframe: slices(rows, (row) => row.timeframe ?? 'M15'),
      regime: slices(rows, (row) => ['TRENDING', 'RANGING', 'TRANSITIONAL'].map((tag) => marketTag(row, tag)).filter(Boolean).length
        ? ['TRENDING', 'RANGING', 'TRANSITIONAL'].map((tag) => marketTag(row, tag)).filter(Boolean) : ['UNAVAILABLE']),
      session: slices(rows, (row) => sessionTags(row).length ? sessionTags(row) : ['UNAVAILABLE']),
      spreadAtr: slices(rows, spreadBucket),
      news: slices(rows, newsTag),
      broker: slices(rows, (row) => row.broker ?? 'UNAVAILABLE'),
      symbol: slices(rows, (row) => row.symbol ?? 'UNAVAILABLE'),
    },
  };
}
