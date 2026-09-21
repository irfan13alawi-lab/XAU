import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateTradeStatistics } from '../src/domain/statistics.mjs';

const now = new Date('2026-09-21T12:00:00.000Z');

function fixtureRows(count, { mixedCurrency = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const winning = index < Math.floor(count / 2);
    const closeReason = index % 6 === 0 ? 'HIT_TP2'
      : index % 5 === 0 ? 'SL_AFTER_TP1'
        : index % 2 === 0 ? 'SL_DIRECT' : 'BREAKEVEN';
    return {
      closedAt: new Date(now.getTime() - index * 60_000).toISOString(),
      netPnl: winning ? '20' : '-10',
      pnlR: winning ? 0.5 : -0.25,
      side: index % 2 ? 'SELL' : 'BUY',
      closeReason,
      setupQuality: ['MTF_4_OF_4', 'SCORE_PASS', 'CONFLUENCE_PASS', 'RR_PASS', 'NEWS_CLEAR'],
      marketConditions: ['TRENDING', 'NORMAL_VOLUME', 'SESSION_LONDON'],
      timeframe: 'M15',
      spreadAtrRatio: 0.03,
      broker: 'TEST_BROKER',
      symbol: 'XAUUSD',
      entryDelaySeconds: 10 + index,
      durationSeconds: 120 + index,
      mfe: '4.2',
      mae: '1.1',
      tp1Hit: index < 10,
      currency: mixedCurrency && index % 2 ? 'EUR' : 'USD',
    };
  });
}

test('journal with fewer than 30 closed trades never presents performance metrics', () => {
  const result = aggregateTradeStatistics(fixtureRows(29), { now, pendingExpiredCount: 2 });
  assert.equal(result.sampleCount, 29);
  assert.equal(result.sufficientSample, false);
  assert.equal(result.metrics, null);
  assert.equal(result.interpretation, 'NO_PERFORMANCE_CONCLUSION_SAMPLE_BELOW_30');
  assert.equal(result.slices.side.BUY.metrics, null);
  assert.equal(result.slices.side.BUY.sampleCount, 15);
  assert.equal(result.pendingExpiredCount, 2);
});

test('30 same-currency paper closes expose reproducible aggregate and cohort metrics', () => {
  const result = aggregateTradeStatistics(fixtureRows(30), { now, pendingExpiredCount: 3 });
  assert.equal(result.sufficientSample, true);
  assert.equal(result.interpretation, 'PAPER_HISTORY_ONLY_NOT_PROFITABILITY_EVIDENCE');
  assert.equal(result.currency, 'USD');
  assert.equal(result.metrics.winRatePct, 50);
  assert.equal(result.metrics.winRateSampleCount, 30);
  assert.deepEqual(result.metrics.winRate95CiPct, {
    lowerPct: 33.1541,
    upperPct: 66.8459,
    method: 'WILSON_SCORE_95',
  });
  assert.equal(result.metrics.profitFactor, 2);
  assert.equal(result.metrics.expectancyR, 0.125);
  assert.equal(result.metrics.expectancyRSampleCount, 30);
  assert.deepEqual(result.metrics.expectancyR95Ci, {
    lower: -0.017421,
    upper: 0.267421,
    method: 'STUDENT_T_CORNISH_FISHER_APPROX_95',
  });
  assert.equal(result.uncertainty.intervalsRequireAtLeast, 30);
  assert.match(result.uncertainty.limitation, /independent trade observations/);
  assert.equal(result.metrics.netPnl, 150);
  assert.equal(result.metrics.netR, 3.75);
  assert.equal(result.metrics.maxDrawdownR, 3.75);
  assert.equal(result.metrics.tp1HitCount, 10);
  assert.equal(result.metrics.tp2CloseCount, 5);
  assert.equal(result.metrics.protectedAfterTp1Count, 5);
  assert.equal(result.slices.setupQuality.SCORE_PASS.sampleCount, 30);
  assert.equal(result.slices.setupQuality.SCORE_PASS.metrics.winRatePct, 50);
  assert.equal(result.slices.regime.TRENDING.sampleCount, 30);
  assert.equal(result.slices.spreadAtr['LOW_<=0.05'].sampleCount, 30);
  assert.equal(result.periods.today.sampleCount, 30);
  assert.equal(result.periods.today.realizedNetPnl, 150);
  assert.equal(result.periods.trailing7Days.realizedLossR, 3.75);
  assert.equal(result.pendingExpiredCount, 3);
});

test('confidence intervals use metric-specific valid sample counts and stay hidden below 30', () => {
  const rows = fixtureRows(30);
  const missingPnl = rows.map((row, index) => index < 2 ? { ...row, netPnl: null } : row);
  const pnlOnly = aggregateTradeStatistics(missingPnl, { now });
  assert.equal(pnlOnly.metrics.winRateSampleCount, 28);
  assert.equal(pnlOnly.metrics.winRate95CiPct, null);
  assert.equal(pnlOnly.metrics.expectancyRSampleCount, 30);
  assert.ok(pnlOnly.metrics.expectancyR95Ci);

  const missingR = rows.map((row, index) => index < 2 ? { ...row, pnlR: null } : row);
  const rOnly = aggregateTradeStatistics(missingR, { now });
  assert.equal(rOnly.metrics.winRateSampleCount, 30);
  assert.ok(rOnly.metrics.winRate95CiPct);
  assert.equal(rOnly.metrics.expectancyRSampleCount, 28);
  assert.equal(rOnly.metrics.expectancyR95Ci, null);
});

test('mixed or unavailable account currencies suppress money metrics instead of combining them', () => {
  const mixed = aggregateTradeStatistics(fixtureRows(30, { mixedCurrency: true }), { now });
  assert.equal(mixed.sufficientSample, true);
  assert.equal(mixed.currency, null);
  assert.equal(mixed.metrics, null);
  assert.equal(mixed.metricsSuppressedReason, 'MIXED_ACCOUNT_CURRENCIES');
  assert.equal(mixed.periods.today.realizedNetPnl, null);
  assert.equal(mixed.periods.today.realizedLossR, 3.75);

  const unknown = fixtureRows(30).map((row) => ({ ...row, currency: null }));
  const unavailable = aggregateTradeStatistics(unknown, { now });
  assert.equal(unavailable.metricsSuppressedReason, 'ACCOUNT_CURRENCY_UNAVAILABLE');
});
