import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildWalkForwardFolds,
  hashResearchDataset,
  runWalkForwardEvaluation,
  verifyResearchReport,
} from '../src/domain/research-evaluation.mjs';
import { persistResearchReport, validateResearchRequest } from '../src/services/research-service.mjs';

const INTERVALS = { H4: 4 * 60 * 60_000, H1: 60 * 60_000, M30: 30 * 60_000, M15: 15 * 60_000 };

function makeDataset() {
  const m15Count = 140;
  const firstM15Close = Date.parse('2025-01-01T00:15:00.000Z');
  const lastM15Close = firstM15Close + (m15Count - 1) * INTERVALS.M15;
  const dataset = {
    schemaVersion: 1,
    symbol: 'XAUUSD',
    manifest: {
      datasetId: 'synthetic-fixture-001',
      dataClass: 'SYNTHETIC_TEST',
      provider: 'SyntheticFixture',
      retrievedAt: new Date(lastM15Close).toISOString(),
    },
    quotes: Array.from({ length: m15Count }, (_, index) => {
      const observedAt = firstM15Close + index * INTERVALS.M15;
      const mid = 2650 + Math.sin(index / 7) * 3 + index * 0.01;
      return {
        observedAt: new Date(observedAt).toISOString(),
        bid: Number((mid - 0.1).toFixed(2)),
        ask: Number((mid + 0.1).toFixed(2)),
        source: 'SYNTHETIC',
      };
    }),
    candlesByTimeframe: {},
    newsSnapshots: [],
    account: { equity: 10_000, currency: 'USD' },
    instrument: {
      contractSize: 100, tickSize: 0.01, tickValue: 1, tickValueCurrency: 'USD',
      minLot: 0.01, lotStep: 0.01, maxLot: 100,
    },
    paperCosts: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1,
      fillLatencyMs: 250, fillRatio: 1, contractSize: 100, quoteToAccountRate: 1,
      lotStep: 0.01, minimumLot: 0.01, breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    maxSpreadPrice: 1,
  };

  dataset.candlesByTimeframe.M15 = Array.from({ length: m15Count }, (_, index) => {
    const closedAt = firstM15Close + index * INTERVALS.M15;
    const mid = 2650 + Math.sin(index / 7) * 3 + index * 0.01;
    return {
      closedAt: new Date(closedAt).toISOString(),
      open: mid - 0.15, high: mid + 0.3, low: mid - 0.3, close: mid + 0.15,
      tickVolume: 100 + index, source: 'SYNTHETIC', quality: 'SYNTHETIC_FIXTURE',
    };
  });
  for (const timeframe of ['M30', 'H1', 'H4']) {
    const interval = INTERVALS[timeframe];
    const count = timeframe === 'M30' ? 120 : 110;
    const latestClose = Math.floor(lastM15Close / interval) * interval;
    dataset.candlesByTimeframe[timeframe] = Array.from({ length: count }, (_, index) => {
      const closedAt = latestClose - (count - 1 - index) * interval;
      const base = 2649 + Math.sin(index / 8) * 2 + index * 0.01;
      return {
        closedAt: new Date(closedAt).toISOString(),
        open: base - 0.1, high: base + 0.25, low: base - 0.25, close: base + 0.1,
        tickVolume: 200 + index, source: 'SYNTHETIC', quality: 'SYNTHETIC_FIXTURE',
      };
    });
  }
  dataset.newsSnapshots = dataset.quotes.map(({ observedAt }) => ({
    fetchedAt: observedAt, status: 'HEALTHY', events: [],
  }));
  dataset.manifest.sha256 = hashResearchDataset(dataset);
  return dataset;
}

test('walk-forward folds are chronologically ordered and leave every test bar in exactly one fold', () => {
  const dataset = makeDataset();
  const folds = buildWalkForwardFolds(dataset.candlesByTimeframe.M15, {
    trainingFraction: 0.7, foldCount: 2, minimumTrainingBars: 100,
  });
  assert.equal(folds.length, 2);
  assert.equal(folds[0].testStartIndex, 100);
  assert.equal(folds[0].testEndIndexExclusive, folds[1].testStartIndex);
  assert.equal(folds.reduce((sum, fold) => sum + fold.testBars, 0), 40);
  assert.throws(() => buildWalkForwardFolds([], { foldCount: 0 }), /WALK_FORWARD_OPTIONS_INVALID/);
});

test('synthetic replay exercises production paper worker but suppresses all PnL evidence', async () => {
  const dataset = makeDataset();
  await assert.rejects(runWalkForwardEvaluation(dataset), /SYNTHETIC_PERFORMANCE_EVALUATION_FORBIDDEN/);
  const report = await runWalkForwardEvaluation(dataset, {
    testOnlyAllowSyntheticData: true,
    trainingFraction: 0.7,
    foldCount: 2,
    minimumTrainingBars: 100,
  });
  assert.equal(report.liveTradingEnabled, false);
  assert.equal(report.profitabilityClaim, false);
  assert.equal(report.performanceEvidenceEligible, false);
  assert.equal(report.evidenceClass, 'SYNTHETIC_SOFTWARE_TEST_ONLY');
  assert.equal(report.folds.length, 2);
  for (const fold of report.folds) {
    assert.equal(fold.scans, fold.expectedTestM15Bars);
    assert.equal(fold.scanCoveragePct, 100);
    assert.equal(fold.performance.metrics, null);
    assert.equal(fold.performance.cohorts, null);
    assert.equal(fold.performance.suppressedReason, 'SYNTHETIC_SOFTWARE_TEST_ONLY');
    assert.ok(fold.decisions.every((decision) => decision.snapshot.market.source === 'SYNTHETIC_FIXTURE'));
    assert.ok(fold.tradeArtifacts.every((trade) => !('netPnl' in trade) && !('grossPnl' in trade)));
  }
  assert.equal(report.provenance.quoteCoverage.gapsOver30Seconds, dataset.quotes.length - 1);
  assert.equal(report.reportSha256, (await runWalkForwardEvaluation(dataset, {
    testOnlyAllowSyntheticData: true,
    trainingFraction: 0.7,
    foldCount: 2,
    minimumTrainingBars: 100,
  })).reportSha256);
  assert.equal(verifyResearchReport(report), true);
  assert.equal(verifyResearchReport({ ...report, evidenceClass: 'ALTERED' }), false);
});

test('research API request contract accepts only a local dataset filename and bounded walk-forward options', () => {
  assert.deepEqual(validateResearchRequest({ datasetName: 'xau-history.json' }), {
    datasetName: 'xau-history.json',
    options: { foldCount: 3, trainingFraction: 0.7, minimumTrainingBars: 100 },
  });
  assert.throws(() => validateResearchRequest({ datasetName: '../outside.json' }), /RESEARCH_DATASET_NAME_INVALID/);
  assert.throws(() => validateResearchRequest({ datasetName: 'xau-history.json', options: { foldCount: 100 } }), /RESEARCH_OPTIONS_INVALID/);
  assert.throws(() => validateResearchRequest({ datasetName: 'xau-history.json', unexpected: true }), /RESEARCH_REQUEST_FIELDS_INVALID/);
});

test('research reports are hash-verified, exclusively created, and never overwrite a conflicting file', async () => {
  const dataset = makeDataset();
  const report = await runWalkForwardEvaluation(dataset, {
    testOnlyAllowSyntheticData: true, trainingFraction: 0.7, foldCount: 2, minimumTrainingBars: 100,
  });
  const tempRoot = mkdtempSync(join(tmpdir(), 'nexora-research-report-'));
  const reportDirectory = resolve(tempRoot, 'reports');
  const reportPath = join(reportDirectory, `${report.runId}.json`);
  try {
    assert.deepEqual(await persistResearchReport(report, reportDirectory), report);
    const original = readFileSync(reportPath, 'utf8');
    assert.deepEqual(await persistResearchReport(report, reportDirectory), report);
    assert.equal(readFileSync(reportPath, 'utf8'), original);

    const tampered = JSON.stringify({ ...report, evidenceClass: 'ALTERED' });
    writeFileSync(reportPath, tampered, 'utf8');
    await assert.rejects(persistResearchReport(report, reportDirectory), /RESEARCH_REPORT_ALREADY_EXISTS_INVALID/);
    assert.equal(readFileSync(reportPath, 'utf8'), tampered);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('dataset tampering and future news snapshots are rejected before replay', async () => {
  const dataset = makeDataset();
  dataset.quotes[0].bid -= 1;
  await assert.rejects(runWalkForwardEvaluation(dataset, { testOnlyAllowSyntheticData: true }), /RESEARCH_DATASET_HASH_MISMATCH/);

  const lookahead = makeDataset();
  lookahead.newsSnapshots.at(-1).fetchedAt = new Date(Date.parse(lookahead.quotes.at(-1).observedAt) + 60_000).toISOString();
  lookahead.manifest.sha256 = hashResearchDataset(lookahead);
  await assert.rejects(runWalkForwardEvaluation(lookahead, { testOnlyAllowSyntheticData: true }), /RESEARCH_NEWS_LOOKAHEAD_INVALID/);
});

test('sparse quote history exposes missed M15 scans and marks coverage incomplete', async () => {
  const dataset = makeDataset();
  const kept = new Set(dataset.quotes.filter((_, index) => index % 4 === 0 || index === dataset.quotes.length - 1)
    .map((quote) => quote.observedAt));
  dataset.quotes = dataset.quotes.filter((quote) => kept.has(quote.observedAt));
  dataset.newsSnapshots = dataset.newsSnapshots.filter((snapshot) => kept.has(snapshot.fetchedAt));
  dataset.manifest.sha256 = hashResearchDataset(dataset);
  const report = await runWalkForwardEvaluation(dataset, {
    testOnlyAllowSyntheticData: true,
    trainingFraction: 0.7,
    foldCount: 2,
    minimumTrainingBars: 100,
  });
  assert.equal(report.performanceEvidenceEligible, false);
  assert.ok(report.folds.every((fold) => fold.scanCoveragePct < 100));
  assert.ok(report.folds.every((fold) => fold.performance.metrics === null));
});
