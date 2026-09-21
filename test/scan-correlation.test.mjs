import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, writeState } from '../src/database.mjs';
import { initializeDatabase } from '../src/server.mjs';
import { reconcilePaperExecution } from '../src/services/paper-lifecycle-service.mjs';
import { persistScanResult } from '../src/services/paper-scan-service.mjs';

const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const costs = {
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
  accountCurrency: 'USD',
};

function brokerQuote(at, bid, ask) {
  const timestamp = at.toISOString();
  return {
    source: 'BROKER', dataFreshness: 'FRESH', bid, ask,
    observedAt: timestamp, receivedAt: timestamp,
  };
}

function acceptedScanResult({ configVersion, candleClosedAt = '2026-09-21T11:45:00.000Z' }) {
  const analyses = ['H4', 'H1', 'M30', 'M15'].map((timeframe) => ({
    timeframe,
    direction: 'LONG',
    strength: 80,
    fresh: true,
    votes: [],
    indicators: {},
    candleClosedAt,
    rejectionReasons: [],
  }));
  return {
    status: 'READY',
    accepted: true,
    direction: 'LONG',
    score: 82,
    confluencePct: 100,
    reasons: [],
    analyses,
    gate: { status: 'READY', reasons: [] },
    plan: { orderType: 'LIMIT', entry: 2001, stop: 1998, takeProfit1: 2005, takeProfit2: 2008, expiresAfterMinutes: 120 },
    sizing: { allowed: true, lots: 0.2, riskAmount: 50, riskPct: 0.5 },
    snapshots: {
      configVersion,
      config: { minSignalScore: 70, minConfluencePct: 60, minRiskReward: 2, version: configVersion },
      market: { source: 'BROKER', quote: { bid: 2000.8, ask: 2000.9 } },
      news: { allowed: true, status: 'HEALTHY' },
      risk: { dailyLossR: 0, drawdownPct: 0, openRiskPct: 0 },
      account: { equity: 10_000, currency: 'USD' },
      paperCosts: costs,
    },
  };
}

test('scan correlation and config version persist through staged order, fill, TP1, and close', () => {
  const db = openDatabase(':memory:', migrations);
  const now = new Date('2026-09-21T12:00:00.000Z');
  initializeDatabase(db, now);
  writeState(db, 'riskMetrics', {
    equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
  }, now.toISOString());
  try {
    const analyses = ['H4', 'H1', 'M30', 'M15'].map((timeframe) => ({
      timeframe,
      direction: 'LONG',
      strength: 80,
      fresh: true,
      votes: [],
      indicators: timeframe === 'H1' ? { adx14: { value: 28 } }
        : timeframe === 'M15' ? { atr14: 4, tickVolumeRatio: { status: 'AVAILABLE', value: 1.1 } } : {},
      candleClosedAt: '2026-09-21T11:45:00.000Z',
      rejectionReasons: [],
    }));
    const result = {
      status: 'READY',
      accepted: true,
      direction: 'LONG',
      score: 82,
      confluencePct: 100,
      reasons: [],
      analyses,
      gate: { status: 'READY', reasons: [] },
      plan: {
        allowed: true,
        orderType: 'LIMIT',
        entry: 2001,
        stop: 1998,
        takeProfit1: 2005,
        takeProfit2: 2008,
        riskReward: 2,
        expiresAfterMinutes: 120,
      },
      sizing: { allowed: true, lots: 0.2, riskAmount: 50, riskPct: 0.5 },
      snapshots: {
        configVersion: 'mtf-paper-fixture-v1',
        config: { minSignalScore: 70, minConfluencePct: 60, minRiskReward: 2, version: 'mtf-paper-fixture-v1' },
        market: {
          source: 'BROKER',
          quote: { bid: 2000.8, ask: 2000.9, observedAt: now.toISOString() },
          session: { active: ['LONDON'], marketScheduleStatus: 'SCHEDULED_OPEN' },
        },
        news: { allowed: true, status: 'HEALTHY' },
        risk: { dailyLossR: 0, drawdownPct: 0, openRiskPct: 0 },
        account: { equity: 10_000, currency: 'USD' },
        paperCosts: costs,
        decision: {
          capturedAt: now.toISOString(),
          direction: 'LONG', score: 82, confluencePct: 100, alignedTimeframes: 4,
          analyses,
          session: { active: ['LONDON'], marketScheduleStatus: 'SCHEDULED_OPEN' },
        },
      },
    };
    const persisted = persistScanResult(db, result, { logicalKey: 'XAUUSD:M15:2026-09-21T11:45:00.000Z', now });
    assert.equal(persisted.accepted, true);

    const scan = db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(persisted.scanId);
    const order = db.prepare('SELECT * FROM orders WHERE signal_id IN (SELECT id FROM signals WHERE scan_id = ?)').get(scan.id);
    const orderSnapshot = JSON.parse(order.snapshot_json);
    assert.equal(order.idempotency_key, 'XAUUSD:M15:2026-09-21T11:45:00.000Z:LONG');
    assert.ok(scan.correlation_id);
    assert.equal(orderSnapshot.correlationId, scan.correlation_id);
    assert.equal(orderSnapshot.scanId, scan.id);
    assert.equal(orderSnapshot.configVersion, scan.config_version);
    assert.ok(db.prepare('SELECT version FROM config_versions WHERE version = ?').get(scan.config_version));

    const fillAt = new Date(now.getTime() + 1_000);
    const fill = reconcilePaperExecution(db, { quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt });
    assert.equal(fill.filled, 1);
    const tp1At = new Date(fillAt.getTime() + 60_000);
    assert.equal(reconcilePaperExecution(db, { quote: brokerQuote(tp1At, 2005.2, 2005.3), costs, now: tp1At }).monitored, 1);
    const tp2At = new Date(tp1At.getTime() + 60_000);
    assert.equal(reconcilePaperExecution(db, { quote: brokerQuote(tp2At, 2008.2, 2008.3), costs, now: tp2At }).closed, 1);

    const position = db.prepare('SELECT id, snapshot_json FROM positions WHERE order_id = ?').get(order.id);
    const trade = db.prepare('SELECT snapshot_json FROM trades WHERE position_id = ?').get(position.id);
    assert.equal(JSON.parse(position.snapshot_json).correlationId, scan.correlation_id);
    assert.equal(JSON.parse(trade.snapshot_json).correlationId, scan.correlation_id);
    const lifecycleAudit = db.prepare(`
      SELECT correlation_id, config_version FROM audit_events
      WHERE (entity_type = 'scan' AND entity_id = ?)
        OR (entity_type = 'order' AND entity_id = ?)
        OR (entity_type = 'position' AND entity_id = ?)
    `).all(scan.id, order.id, position.id);
    assert.ok(lifecycleAudit.length >= 5);
    assert.equal(lifecycleAudit.every((event) => event.correlation_id === scan.correlation_id), true);
    assert.equal(lifecycleAudit.every((event) => event.config_version === scan.config_version), true);
  } finally {
    db.close();
  }
});

test('terminal logical setup cannot be staged again for the same candle and direction after config changes', () => {
  const db = openDatabase(':memory:', migrations);
  const now = new Date('2026-09-21T12:00:00.000Z');
  initializeDatabase(db, now);
  try {
    const first = persistScanResult(db, acceptedScanResult({ configVersion: 'mtf-paper-fixture-v1' }), {
      logicalKey: 'XAUUSD:M15:2026-09-21T11:45:00.000Z:attempt-1', now,
    });
    assert.equal(first.accepted, true);
    db.prepare("UPDATE orders SET status = 'EXPIRED' WHERE signal_id IN (SELECT id FROM signals WHERE scan_id = ?)")
      .run(first.scanId);
    db.prepare("UPDATE signals SET status = 'EXPIRED' WHERE scan_id = ?").run(first.scanId);

    const next = persistScanResult(db, acceptedScanResult({ configVersion: 'mtf-paper-fixture-v2' }), {
      logicalKey: 'XAUUSD:M15:2026-09-21T11:45:00.000Z:attempt-2', now: new Date(now.getTime() + 1000),
    });
    assert.equal(next.accepted, false);
    assert.equal(next.status, 'REJECTED');
    assert.ok(next.reasons.includes('DUPLICATE_LOGICAL_SETUP'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM signals').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 2);
  } finally {
    db.close();
  }
});
