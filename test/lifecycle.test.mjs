import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, readState, writeState } from '../src/database.mjs';
import { dashboardSnapshot, initializeDatabase } from '../src/server.mjs';
import { closePaperPosition, reconcilePaperExecution } from '../src/services/paper-lifecycle-service.mjs';

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

function fixtureDatabase() {
  const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
  const db = openDatabase(':memory:', migrations);
  const now = new Date('2026-09-21T12:00:00.000Z');
  initializeDatabase(db, now);
  writeState(db, 'riskMetrics', {
    equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
  }, now.toISOString());
  db.prepare(`
    INSERT INTO scan_runs (id, idempotency_key, symbol, started_at, completed_at, status, reason_json, config_version, correlation_id)
    VALUES ('scan-0001', 'scan-logical-0001', 'XAUUSD', ?, ?, 'ORDER_STAGED', '[]', 'mtf-paper-v1', 'corr-0001')
  `).run('2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z');
  db.prepare(`
    INSERT INTO signals (id, scan_id, logical_setup_key, direction, status, entry_price, stop_price,
      take_profit_1, take_profit_2, score, snapshot_json, created_at)
    VALUES ('signal-0001', 'scan-0001', 'setup-logical-0001', 'LONG', 'PENDING', '2001', '1998', '2005', '2008', 80, '{}', '2026-09-21T12:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO orders (id, idempotency_key, signal_id, symbol, side, order_type, status, quantity_lots,
      entry_price, stop_price, take_profit_1, take_profit_2, expires_at, created_at, updated_at, snapshot_json,
      remaining_quantity_lots)
    VALUES ('order-0001', 'order-logical-0001', 'signal-0001', 'XAUUSD', 'BUY', 'LIMIT', 'PENDING', '0.2',
      '2001', '1998', '2005', '2008', '2026-09-21T14:00:00.000Z', '2026-09-21T12:00:00.000Z',
      '2026-09-21T12:00:00.000Z', ?, '0.2')
  `).run(JSON.stringify({
    configVersion: 'mtf-paper-v1',
    account: { equity: 10_000, currency: 'USD' },
    sizing: { lots: 0.2, riskAmount: 50 },
    paperCosts: null,
    plan: { entry: 2001, stop: 1998, takeProfit1: 2005, takeProfit2: 2008, riskReward: 2 },
    market: {
      source: 'BROKER',
      quote: { bid: 2000, ask: 2000.2 },
      session: { active: ['LONDON'], marketScheduleStatus: 'SCHEDULED_OPEN · HOLIDAYS UNKNOWN' },
    },
    snapshots: {
      config: { minSignalScore: 70, minConfluencePct: 60, minRiskReward: 2 },
      news: { allowed: true, status: 'HEALTHY' },
      decision: {
        alignedTimeframes: 3,
        score: 82,
        confluencePct: 75,
        analyses: [
          { timeframe: 'H1', indicators: { adx14: { value: 28 } } },
          { timeframe: 'M15', indicators: { atr14: 4, tickVolumeRatio: { status: 'AVAILABLE', value: 1.1 } } },
        ],
        session: { active: ['LONDON'], marketScheduleStatus: 'SCHEDULED_OPEN · HOLIDAYS UNKNOWN' },
      },
    },
  }));
  return db;
}

function brokerQuote(now, bid, ask, overrides = {}) {
  const at = now.toISOString();
  return { source: 'BROKER', dataFreshness: 'FRESH', bid, ask, observedAt: at, receivedAt: at, ...overrides };
}

test('paper lifecycle persists fill, TP1 partial, break-even, TP2 trade, ledger, and replay safety', () => {
  const db = fixtureDatabase();
  const t0 = new Date('2026-09-21T12:00:00.000Z');
  try {
    const tooEarly = reconcilePaperExecution(db, { quote: brokerQuote(t0, 2000.8, 2000.9), costs, now: t0 });
    assert.equal(tooEarly.filled, 0);
    assert.ok(tooEarly.reasons.includes('SIMULATED_FILL_LATENCY_WAIT'));
    const fillAt = new Date(t0.getTime() + 1000);
    const fill = reconcilePaperExecution(db, { quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt });
    assert.equal(fill.filled, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'FILLED');
    let position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.status, 'OPEN');
    assert.equal(Number(position.quantity_open_lots), 0.2);
    assert.equal(Number(position.commission_paid), 0.4);

    const t1 = new Date(fillAt.getTime() + 60_000);
    const tp1 = reconcilePaperExecution(db, { quote: brokerQuote(t1, 2005.2, 2005.3), costs, now: t1 });
    assert.equal(tp1.monitored, 1);
    position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.status, 'PARTIAL');
    assert.equal(position.tp1_hit, 1);
    assert.equal(Number(position.quantity_open_lots), 0.1);
    assert.equal(Number(position.stop_price), 2001.05);

    const t2 = new Date(t1.getTime() + 60_000);
    const tp2 = reconcilePaperExecution(db, { quote: brokerQuote(t2, 2008.2, 2008.3), costs, now: t2 });
    assert.equal(tp2.closed, 1);
    const trade = db.prepare('SELECT * FROM trades WHERE position_id = ?').get(position.id);
    assert.equal(trade.close_reason, 'HIT_TP2');
    assert.equal(Number(trade.gross_pnl), 112);
    assert.equal(Number(trade.commission), 0.8);
    assert.equal(Number(trade.net_pnl), 111.2);
    assert.ok(Number(trade.pnl_r) > 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_snapshots WHERE trade_id = ?').get(trade.id).n, 3);
    assert.equal(trade.review_class, 'WIN_REVIEW');
    assert.ok(trade.setup_quality.includes('MTF_3_OF_4'));
    assert.ok(trade.setup_quality.includes('SCORE_PASS'));
    assert.ok(trade.setup_quality.includes('NEWS_CLEAR'));
    assert.ok(trade.market_condition.includes('TRENDING'));
    assert.ok(trade.market_condition.includes('SESSION_LONDON'));
    const savedTradeSnapshot = JSON.parse(trade.snapshot_json);
    assert.ok(Math.abs(savedTradeSnapshot.classification.spreadAtrRatio - 0.05) < 1e-9);
    assert.equal(savedTradeSnapshot.executionCosts.accountCurrency, 'USD');
    assert.equal(savedTradeSnapshot.correlationId, 'corr-0001');
    const lifecycleAudit = db.prepare(`
      SELECT correlation_id, config_version FROM audit_events
      WHERE (entity_type = 'order' AND entity_id = 'order-0001')
        OR (entity_type = 'position' AND entity_id = ?)
    `).all(position.id);
    assert.ok(lifecycleAudit.length >= 3);
    assert.equal(lifecycleAudit.every((event) => event.correlation_id === 'corr-0001'), true);
    assert.equal(lifecycleAudit.every((event) => event.config_version === 'mtf-paper-v1'), true);
    const positionEventDetails = db.prepare('SELECT details_json FROM position_events WHERE position_id = ?').all(position.id)
      .map((event) => JSON.parse(event.details_json));
    assert.equal(positionEventDetails.every((event) => event.correlationId === 'corr-0001'), true);
    const dashboard = dashboardSnapshot(db, t2);
    assert.equal(dashboard.statistics.sampleCount, 1);
    assert.equal(dashboard.statistics.currency, 'USD');
    assert.equal(dashboard.statistics.periods.today.realizedNetPnl, 111.2);
    assert.equal(dashboard.statistics.slices.broker.BROKER.sampleCount, 1);
    assert.equal(dashboard.account.dailyPnl, 111.2);
    assert.equal(dashboard.counts.forwardPaperTrades, 1);
    assert.equal(dashboard.counts.forwardPaperTradesRequired, 100);
    assert.equal(trade.entry_delay_seconds, 1);
    const snapshotTypes = db.prepare('SELECT snapshot_type FROM trade_snapshots WHERE trade_id = ? ORDER BY created_at, snapshot_type').all(trade.id).map((item) => item.snapshot_type);
    assert.deepEqual(snapshotTypes, ['ENTRY', 'TP1', 'CLOSE']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_events WHERE position_id = ?').get(position.id).n, 3);
    assert.equal(readState(db, 'entryPaused'), true);

    const replay = reconcilePaperExecution(db, { quote: brokerQuote(t2, 2008.2, 2008.3), costs, now: t2 });
    assert.equal(replay.closed, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
  } finally {
    db.close();
  }
});

test('short paper lifecycle uses bid to enter and ask to mark, protect, and close the position', () => {
  const db = fixtureDatabase();
  const orderSnapshot = JSON.parse(db.prepare('SELECT snapshot_json FROM orders WHERE id = ?').get('order-0001').snapshot_json);
  orderSnapshot.plan = { ...orderSnapshot.plan, entry: 2001, stop: 2004, takeProfit1: 1995, takeProfit2: 1992 };
  orderSnapshot.snapshots.decision.direction = 'SHORT';
  db.prepare(`UPDATE signals SET direction = 'SHORT', stop_price = '2004', take_profit_1 = '1995', take_profit_2 = '1992' WHERE id = 'signal-0001'`).run();
  db.prepare(`UPDATE orders SET side = 'SELL', stop_price = '2004', take_profit_1 = '1995', take_profit_2 = '1992', snapshot_json = ? WHERE id = 'order-0001'`)
    .run(JSON.stringify(orderSnapshot));
  const t0 = new Date('2026-09-21T12:00:00.000Z');
  try {
    const sellLimitUntriggered = reconcilePaperExecution(db, {
      quote: brokerQuote(new Date(t0.getTime() + 1000), 2000.8, 2001.2), costs, now: new Date(t0.getTime() + 1000),
    });
    assert.equal(sellLimitUntriggered.filled, 0, 'SELL LIMIT must not trigger from ask alone');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'PENDING');

    const fillAt = new Date(t0.getTime() + 2000);
    const fill = reconcilePaperExecution(db, {
      quote: brokerQuote(fillAt, 2001.2, 2001.4), costs, now: fillAt,
    });
    assert.equal(fill.filled, 1);
    let position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.side, 'SHORT');
    assert.equal(Number(position.entry_price), 2001.1);
    assert.equal(Number(position.mark_price), 2001.4, 'SHORT mark must use ask');

    const t1NotReached = new Date(fillAt.getTime() + 60_000);
    reconcilePaperExecution(db, {
      quote: brokerQuote(t1NotReached, 1994.9, 1995.1), costs, now: t1NotReached,
    });
    position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.tp1_hit, 0, 'SHORT target must not trigger from bid alone');

    const t1At = new Date(t1NotReached.getTime() + 60_000);
    const tp1 = reconcilePaperExecution(db, {
      quote: brokerQuote(t1At, 1994.7, 1994.9), costs, now: t1At,
    });
    assert.equal(tp1.monitored, 1);
    position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.status, 'PARTIAL');
    assert.equal(position.tp1_hit, 1);
    assert.equal(Number(position.quantity_open_lots), 0.1);
    assert.equal(Number(position.stop_price), 2001.05);

    const t2 = new Date(t1At.getTime() + 60_000);
    assert.equal(reconcilePaperExecution(db, {
      quote: brokerQuote(t2, 1991.6, 1991.8), costs, now: t2,
    }).closed, 1);
    const trade = db.prepare('SELECT * FROM trades WHERE position_id = ?').get(position.id);
    assert.equal(trade.side, 'SHORT');
    assert.equal(trade.close_reason, 'HIT_TP2');
    assert.equal(Number(trade.gross_pnl), 153);
    assert.equal(Number(trade.commission), 0.8);
    assert.equal(Number(trade.net_pnl), 152.2);
    assert.deepEqual(db.prepare('SELECT snapshot_type FROM trade_snapshots WHERE trade_id = ? ORDER BY created_at, snapshot_type').all(trade.id)
      .map((row) => row.snapshot_type), ['ENTRY', 'TP1', 'CLOSE']);
    const replay = reconcilePaperExecution(db, { quote: brokerQuote(t2, 1991.6, 1991.8), costs, now: t2 });
    assert.equal(replay.closed, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
  } finally {
    db.close();
  }
});

test('symbol-scoped reconciliation never fills an order with another symbol quote', () => {
  const db = fixtureDatabase();
  const orderSnapshot = JSON.parse(db.prepare('SELECT snapshot_json FROM orders WHERE id = ?').get('order-0001').snapshot_json);
  const secondSnapshot = JSON.stringify({ ...orderSnapshot, market: { ...orderSnapshot.market, quote: { bid: 2000, ask: 2000.2 } } });
  db.prepare('UPDATE orders SET symbol = \'EURUSD\' WHERE id = ?').run('order-0001');
  db.prepare(`
    INSERT INTO signals (id, scan_id, logical_setup_key, direction, status, entry_price, stop_price,
      take_profit_1, take_profit_2, score, snapshot_json, created_at)
    VALUES ('signal-0002', 'scan-0001', 'setup-logical-0002', 'LONG', 'PENDING', '2001', '1998', '2005', '2008', 80, '{}', '2026-09-21T12:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO orders (id, idempotency_key, signal_id, symbol, side, order_type, status, quantity_lots,
      entry_price, stop_price, take_profit_1, take_profit_2, expires_at, created_at, updated_at, snapshot_json,
      remaining_quantity_lots)
    VALUES ('order-0002', 'order-logical-0002', 'signal-0002', 'GBPUSD', 'BUY', 'LIMIT', 'PENDING', '0.2',
      '2001', '1998', '2005', '2008', '2026-09-21T14:00:00.000Z', '2026-09-21T12:00:00.000Z',
      '2026-09-21T12:00:00.000Z', ?, '0.2')
  `).run(secondSnapshot);
  const fillAt = new Date('2026-09-21T12:00:01.000Z');
  try {
    const eur = reconcilePaperExecution(db, {
      symbol: 'EURUSD', quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt,
    });
    assert.equal(eur.filled, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0002').status, 'PENDING');
    assert.equal(JSON.parse(db.prepare('SELECT snapshot_json FROM positions WHERE order_id = ?').get('order-0001').snapshot_json).lastFill.quote.bid, 2000.8);

    const gbp = reconcilePaperExecution(db, {
      symbol: 'GBPUSD', quote: brokerQuote(new Date(fillAt.getTime() + 1000), 2000.8, 2000.9), costs, now: new Date(fillAt.getTime() + 1000),
    });
    assert.equal(gbp.filled, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions WHERE status = \'OPEN\'').get().n, 2);
  } finally {
    db.close();
  }
});

test('operator manual close requires a fresh broker quote and atomically journals a paper exit', () => {
  const db = fixtureDatabase();
  const t0 = new Date('2026-09-21T12:00:00.000Z');
  try {
    const fillAt = new Date(t0.getTime() + 1000);
    assert.equal(reconcilePaperExecution(db, { quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt }).filled, 1);
    const position = db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").get();
    const closeAt = new Date(fillAt.getTime() + 60_000);
    const offlineDashboard = dashboardSnapshot(db, closeAt);
    assert.equal(offlineDashboard.market.dataFreshness, 'UNAVAILABLE');
    assert.equal(offlineDashboard.positions.length, 1);
    assert.equal(offlineDashboard.positions[0].id, position.id);
    assert.equal(Number(offlineDashboard.positions[0].mark_price), 2000.8);
    assert.equal(offlineDashboard.positions[0].lastMarkAt, fillAt.toISOString());
    const stale = closePaperPosition(db, {
      positionId: position.id,
      quote: brokerQuote(new Date(closeAt.getTime() - 31_000), 2002, 2002.2), costs, now: closeAt,
    });
    assert.equal(stale.updated, false);
    assert.equal(stale.reason, 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED');
    assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(position.id).status, 'OPEN');

    db.exec('BEGIN IMMEDIATE');
    const rolledBackClose = closePaperPosition(db, {
      positionId: position.id, quote: brokerQuote(closeAt, 2002, 2002.2), costs, now: closeAt, withinTransaction: true,
    });
    assert.equal(rolledBackClose.closed, true);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(position.id).status, 'OPEN');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0);

    const closed = closePaperPosition(db, {
      positionId: position.id, quote: brokerQuote(closeAt, 2002, 2002.2), costs, now: closeAt,
      httpRequestId: '0198e4c7-4f18-4b3b-9a23-52f3e1de7d11',
    });
    assert.equal(closed.closed, true);
    assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(position.id).status, 'CLOSED');
    const trade = db.prepare('SELECT * FROM trades WHERE position_id = ?').get(position.id);
    assert.equal(trade.close_reason, 'MANUAL_CLOSE');
    assert.equal(Number(trade.gross_pnl), 18);
    assert.equal(Number(trade.commission), 0.8);
    assert.equal(Number(trade.net_pnl), 17.2);
    const event = db.prepare(`SELECT * FROM audit_events WHERE event_type = 'PAPER_POSITION_MANUALLY_CLOSED'`).get();
    assert.equal(event.actor, 'operator');
    assert.equal(event.correlation_id, 'corr-0001');
    assert.equal(JSON.parse(event.metadata_json).httpRequestId, '0198e4c7-4f18-4b3b-9a23-52f3e1de7d11');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_PARTIAL_GROSS'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_snapshots WHERE trade_id = ?').get(trade.id).n, 2);
  } finally {
    db.close();
  }
});

test('stale quote cannot fill an order, but expiry still advances without market data', () => {
  const db = fixtureDatabase();
  const now = new Date('2026-09-21T12:00:00.000Z');
  try {
    const stale = brokerQuote(new Date(now.getTime() - 31_000), 2000.8, 2000.9);
    const held = reconcilePaperExecution(db, { quote: stale, costs, now });
    assert.ok(held.reasons.includes('VERIFIED_FRESH_BROKER_QUOTE_REQUIRED'));
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'PENDING');

    const expiry = new Date('2026-09-21T14:00:00.000Z');
    const expired = reconcilePaperExecution(db, { quote: null, costs, now: expiry });
    assert.equal(expired.expired, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'EXPIRED');
    const audit = db.prepare("SELECT correlation_id, config_version FROM audit_events WHERE entity_id = 'order-0001'").get();
    assert.equal(audit.correlation_id, 'corr-0001');
    assert.equal(audit.config_version, 'mtf-paper-v1');
  } finally {
    db.close();
  }
});

test('stale risk state holds a fill without changing the pending order', () => {
  const db = fixtureDatabase();
  const t0 = new Date('2026-09-21T12:00:00.000Z');
  try {
    writeState(db, 'riskMetrics', {
      equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
    }, new Date(t0.getTime() - 31_000).toISOString());
    const fillAt = new Date(t0.getTime() + 1000);
    const result = reconcilePaperExecution(db, {
      quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt,
    });

    assert.ok(result.reasons.includes('RISK_STATE_STALE'));
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'PENDING');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
  } finally {
    db.close();
  }
});

test('fill recalculates pending exposure with fresh equity and rejects a breached total-risk limit', () => {
  const db = fixtureDatabase();
  const now = new Date('2026-09-21T12:00:01.000Z');
  try {
    // The order carries $50 risk. Current equity of $500 makes that pending exposure 10%,
    // above the 5% portfolio cap even though the scan originally used $10,000 equity.
    writeState(db, 'riskMetrics', {
      equity: 500, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
    }, now.toISOString());
    const result = reconcilePaperExecution(db, {
      quote: brokerQuote(now, 2000.8, 2000.9), costs, now,
    });

    assert.ok(result.reasons.includes('TOTAL_OPEN_RISK_LIMIT'));
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'REJECTED');
    assert.equal(db.prepare('SELECT status FROM signals WHERE id = ?').get('signal-0001').status, 'REJECTED');
    assert.equal(readState(db, 'entryPaused'), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_RISK_REJECTED'").get().n, 1);
  } finally {
    db.close();
  }
});

test('partial fills are deduplicated by quote time and do not strand a minimum-lot remainder', () => {
  const db = fixtureDatabase();
  const start = new Date('2026-09-21T12:00:00.000Z');
  const partialCosts = { ...costs, fillRatio: 0.5 };
  try {
    const firstAt = new Date(start.getTime() + 1000);
    const firstQuote = brokerQuote(firstAt, 2000.8, 2000.9);
    const first = reconcilePaperExecution(db, { quote: firstQuote, costs: partialCosts, now: firstAt });
    assert.equal(first.filled, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'PARTIAL');
    assert.equal(Number(db.prepare('SELECT remaining_quantity_lots FROM orders WHERE id = ?').get('order-0001').remaining_quantity_lots), 0.1);
    assert.equal(Number(db.prepare('SELECT quantity_open_lots FROM positions WHERE order_id = ?').get('order-0001').quantity_open_lots), 0.1);

    const duplicate = reconcilePaperExecution(db, { quote: firstQuote, costs: partialCosts, now: firstAt });
    assert.ok(duplicate.reasons.includes('QUOTE_ALREADY_MATCHED'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_PARTIALLY_FILLED'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 1);

    const nextAt = new Date(start.getTime() + 2000);
    const next = reconcilePaperExecution(db, {
      quote: brokerQuote(nextAt, 2000.8, 2000.9), costs: partialCosts, now: nextAt,
    });
    assert.equal(next.filled, 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'FILLED');
    assert.equal(Number(db.prepare('SELECT quantity_initial_lots FROM positions WHERE order_id = ?').get('order-0001').quantity_initial_lots), 0.2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type IN ('PARTIAL_FILL', 'FILL')").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 2);
  } finally {
    db.close();
  }
});

test('observed stop gaps execute at the current quote and persist gap evidence in the paper journal', () => {
  const db = fixtureDatabase();
  const start = new Date('2026-09-21T12:00:00.000Z');
  try {
    const fillAt = new Date(start.getTime() + 1000);
    assert.equal(reconcilePaperExecution(db, {
      quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt,
    }).filled, 1);

    const gapAt = new Date(fillAt.getTime() + 60_000);
    const result = reconcilePaperExecution(db, {
      quote: brokerQuote(gapAt, 1995, 1995.2), costs, now: gapAt,
    });
    assert.equal(result.closed, 1);

    const position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get('order-0001');
    assert.equal(position.close_reason, 'SL_DIRECT');
    const eventRow = db.prepare(`SELECT details_json FROM position_events WHERE position_id = ? AND event_type = 'SL_DIRECT'`).get(position.id);
    const event = JSON.parse(eventRow.details_json);
    assert.equal(event.stopPrice, 1998);
    assert.equal(event.stopGapPrice, 3);
    assert.equal(event.referencePrice, 1995);
    assert.equal(event.price, 1994.9);

    const auditRow = db.prepare(`SELECT metadata_json FROM audit_events WHERE event_type = 'PAPER_POSITION_CLOSED' AND entity_id = ?`).get(position.id);
    assert.equal(JSON.parse(auditRow.metadata_json).events[0].stopGapPrice, 3);
  } finally {
    db.close();
  }
});

test('TP1 protects a minimum-lot partial entry at break-even and cancels its unfilled remainder', () => {
  const db = fixtureDatabase();
  const start = new Date('2026-09-21T12:00:00.000Z');
  const partialCosts = { ...costs, fillRatio: 0.5 };
  try {
    const fillAt = new Date(start.getTime() + 1000);
    assert.equal(reconcilePaperExecution(db, {
      quote: brokerQuote(fillAt, 2000.8, 2000.9), costs: partialCosts, now: fillAt,
    }).filled, 1);
    assert.equal(Number(db.prepare('SELECT quantity_open_lots FROM positions LIMIT 1').get().quantity_open_lots), 0.1);

    const tp1At = new Date(start.getTime() + 60_000);
    const quote = brokerQuote(tp1At, 2005.2, 2005.3);
    const tp1 = reconcilePaperExecution(db, { quote, costs: partialCosts, now: tp1At });
    assert.equal(tp1.monitored, 1);
    const position = db.prepare('SELECT * FROM positions LIMIT 1').get();
    assert.equal(position.status, 'PARTIAL');
    assert.equal(position.tp1_hit, 1);
    assert.equal(Number(position.quantity_open_lots), 0.1);
    assert.equal(Number(position.stop_price), 2001.05);
    assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'CANCELLED');
    const tp1Event = db.prepare("SELECT details_json FROM position_events WHERE event_type = 'HIT_TP1'").get();
    assert.equal(JSON.parse(tp1Event.details_json).partialCloseUnavailableReason, 'TP1_PARTIAL_BELOW_MINIMUM_LOT');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_REMAINDER_CANCELLED'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type IN ('REALIZED_PARTIAL_GROSS', 'EXIT_COMMISSION')").get().n, 0);

    reconcilePaperExecution(db, { quote, costs: partialCosts, now: tp1At });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_REMAINDER_CANCELLED'").get().n, 1);
  } finally {
    db.close();
  }
});

test('paper OFF cancels unfilled orders and continues managing already-open paper positions', () => {
  const pendingDb = fixtureDatabase();
  const t0 = new Date('2026-09-21T12:00:00.000Z');
  try {
    const stopped = reconcilePaperExecution(pendingDb, { quote: brokerQuote(t0, 2000.8, 2000.9), costs, paperMode: false, now: t0 });
    assert.equal(stopped.cancelled, 1);
    assert.equal(stopped.filled, 0);
    assert.ok(stopped.reasons.includes('PAPER_MODE_DISABLED'));
    assert.equal(pendingDb.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'CANCELLED');
    assert.equal(pendingDb.prepare('SELECT status FROM signals WHERE id = ?').get('signal-0001').status, 'CANCELLED');
    assert.equal(pendingDb.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
    assert.equal(pendingDb.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_CANCELLED'").get().n, 1);
  } finally {
    pendingDb.close();
  }

  const openDb = fixtureDatabase();
  try {
    const fillAt = new Date(t0.getTime() + 1000);
    const filled = reconcilePaperExecution(openDb, { quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt });
    assert.equal(filled.filled, 1);
    const t1 = new Date(fillAt.getTime() + 60_000);
    const monitored = reconcilePaperExecution(openDb, { quote: brokerQuote(t1, 2005.2, 2005.3), costs, paperMode: false, now: t1 });
    assert.equal(monitored.monitored, 1);
    assert.equal(monitored.closed, 0);
    assert.equal(openDb.prepare('SELECT status FROM positions WHERE order_id = ?').get('order-0001').status, 'PARTIAL');
    assert.equal(openDb.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0);
  } finally {
    openDb.close();
  }
});

test('audit-store failure rolls back the paper fill and leaves the order pending', () => {
  const db = fixtureDatabase();
  const now = new Date('2026-09-21T12:00:00.000Z');
  try {
    db.exec('DROP TABLE audit_events');
    const fillAt = new Date(now.getTime() + 1000);
    assert.throws(() => reconcilePaperExecution(db, {
      quote: brokerQuote(fillAt, 2000.8, 2000.9), costs, now: fillAt,
    }), /audit_events/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get('order-0001').status, 'PENDING');
  } finally {
    db.close();
  }
});
