import { fileURLToPath } from 'node:url';
import { openDatabase, writeState } from '../src/database.mjs';
import { initializeDatabase } from '../src/server.mjs';
import { closePaperPosition, reconcilePaperExecution } from '../src/services/paper-lifecycle-service.mjs';
import { persistScanResult } from '../src/services/paper-scan-service.mjs';

const [databasePath, phase] = process.argv.slice(2);
const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const db = openDatabase(databasePath, migrations);
const now = new Date('2026-09-21T12:00:00.000Z');
initializeDatabase(db, now);

if (phase === 'committed-order') {
  writeState(db, 'entryPaused', false, now.toISOString());
  persistScanResult(db, {
    status: 'ORDER_STAGED',
    accepted: true,
    direction: 'LONG',
    score: 82,
    confluencePct: 75,
    plan: { orderType: 'LIMIT', entry: 2650, stop: 2647, takeProfit1: 2656, takeProfit2: 2659, riskReward: 2, expiresAfterMinutes: 120 },
    sizing: { lots: 0.1, riskAmount: 30 },
    analyses: [{
      timeframe: 'M15', direction: 'LONG', strength: 0.8, votes: [], indicators: {},
      rejectionReasons: [], candleClosedAt: '2026-09-21T12:00:00.000Z',
    }],
    snapshots: {
      configVersion: 'mtf-paper-v1',
      account: { equity: 10_000, currency: 'USD' },
      market: { source: 'BROKER', quote: { bid: 2650, ask: 2650.2 } },
      risk: { allowed: true },
    },
  }, { logicalKey: 'XAUUSD:M15:crash-fixture:mtf-paper-v1', now });
} else if (phase === 'uncommitted-order') {
  db.exec('BEGIN IMMEDIATE');
  writeState(db, 'entryPaused', false, now.toISOString());
  persistScanResult(db, {
    status: 'ORDER_STAGED',
    accepted: true,
    direction: 'LONG',
    score: 82,
    confluencePct: 75,
    plan: { orderType: 'LIMIT', entry: 2650, stop: 2647, takeProfit1: 2656, takeProfit2: 2659, riskReward: 2, expiresAfterMinutes: 120 },
    sizing: { lots: 0.1, riskAmount: 30 },
    analyses: [{
      timeframe: 'M15', direction: 'LONG', strength: 0.8, votes: [], indicators: {},
      rejectionReasons: [], candleClosedAt: '2026-09-21T12:00:00.000Z',
    }],
    snapshots: {
      configVersion: 'mtf-paper-v1',
      account: { equity: 10_000, currency: 'USD' },
      market: { source: 'BROKER', quote: { bid: 2650, ask: 2650.2 } },
      risk: { allowed: true },
    },
    }, { logicalKey: 'XAUUSD:M15:crash-fixture:mtf-paper-v1', now, transactional: false });
} else if (phase === 'committed-partial-fill') {
  const fillAt = new Date('2026-09-21T12:00:02.000Z');
  reconcilePaperExecution(db, {
    quote: {
      source: 'BROKER', dataFreshness: 'FRESH', bid: 2649.7, ask: 2649.9,
      observedAt: fillAt.toISOString(), receivedAt: fillAt.toISOString(),
    },
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: 0.5, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: fillAt,
  });
} else if (phase.startsWith('fill-crash-') || phase.startsWith('partial-fill-crash-')) {
  const partialFill = phase.startsWith('partial-fill-crash-');
  const prefix = partialFill ? 'partial-fill-crash-' : 'fill-crash-';
  const point = phase.slice(prefix.length);
  const fullFillTriggers = {
    audit: `CREATE TRIGGER test_fill_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_ORDER_FILLED' BEGIN SELECT nexora_test_crash(); END`,
    position: `CREATE TRIGGER test_fill_crashpoint AFTER INSERT ON positions
      BEGIN SELECT nexora_test_crash(); END`,
    order: `CREATE TRIGGER test_fill_crashpoint AFTER UPDATE ON orders
      WHEN NEW.status = 'FILLED' BEGIN SELECT nexora_test_crash(); END`,
    signal: `CREATE TRIGGER test_fill_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'OPEN' BEGIN SELECT nexora_test_crash(); END`,
    'position-event': `CREATE TRIGGER test_fill_crashpoint AFTER INSERT ON position_events
      WHEN NEW.event_type = 'FILL' BEGIN SELECT nexora_test_crash(); END`,
    ledger: `CREATE TRIGGER test_fill_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'ENTRY_COMMISSION' BEGIN SELECT nexora_test_crash(); END`,
  };
  const partialFillTriggers = {
    audit: `CREATE TRIGGER test_partial_fill_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_ORDER_PARTIALLY_FILLED' BEGIN SELECT nexora_test_crash(); END`,
    position: `CREATE TRIGGER test_partial_fill_crashpoint AFTER INSERT ON positions
      BEGIN SELECT nexora_test_crash(); END`,
    order: `CREATE TRIGGER test_partial_fill_crashpoint AFTER UPDATE ON orders
      WHEN NEW.status = 'PARTIAL' BEGIN SELECT nexora_test_crash(); END`,
    signal: `CREATE TRIGGER test_partial_fill_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'PARTIAL' BEGIN SELECT nexora_test_crash(); END`,
    'position-event': `CREATE TRIGGER test_partial_fill_crashpoint AFTER INSERT ON position_events
      WHEN NEW.event_type = 'PARTIAL_FILL' BEGIN SELECT nexora_test_crash(); END`,
    ledger: `CREATE TRIGGER test_partial_fill_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'ENTRY_COMMISSION' BEGIN SELECT nexora_test_crash(); END`,
  };
  const triggerByPoint = partialFill ? partialFillTriggers : fullFillTriggers;
  if (!Object.hasOwn(triggerByPoint, point)) throw new Error('Unsupported fill crash point.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(triggerByPoint[point]);
  const fillAt = new Date('2026-09-21T12:00:02.000Z');
  reconcilePaperExecution(db, {
    quote: {
      source: 'BROKER', dataFreshness: 'FRESH', bid: 2649.7, ask: 2649.9,
      observedAt: fillAt.toISOString(), receivedAt: fillAt.toISOString(),
    },
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: partialFill ? 0.5 : 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: fillAt,
  });
  db.close();
  process.exit(0);
} else if (phase.startsWith('tp1-crash-') || phase.startsWith('close-crash-')) {
  const group = phase.startsWith('tp1-crash-') ? 'tp1' : 'close';
  const point = phase.slice(`${group}-crash-`.length);
  const triggerByPoint = {
    'tp1-audit': `CREATE TRIGGER test_tp1_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_POSITION_UPDATED' BEGIN SELECT nexora_test_crash(); END`,
    'tp1-position': `CREATE TRIGGER test_tp1_crashpoint AFTER UPDATE ON positions
      WHEN NEW.status = 'PARTIAL' AND NEW.tp1_hit = 1 BEGIN SELECT nexora_test_crash(); END`,
    'tp1-position-event': `CREATE TRIGGER test_tp1_crashpoint AFTER INSERT ON position_events
      WHEN NEW.event_type = 'HIT_TP1' BEGIN SELECT nexora_test_crash(); END`,
    'tp1-gross-ledger': `CREATE TRIGGER test_tp1_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'REALIZED_PARTIAL_GROSS' BEGIN SELECT nexora_test_crash(); END`,
    'tp1-commission-ledger': `CREATE TRIGGER test_tp1_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'EXIT_COMMISSION' BEGIN SELECT nexora_test_crash(); END`,
    'tp1-signal': `CREATE TRIGGER test_tp1_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'PARTIAL' BEGIN SELECT nexora_test_crash(); END`,
    'close-audit': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_POSITION_CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    'close-position': `CREATE TRIGGER test_close_crashpoint AFTER UPDATE ON positions
      WHEN NEW.status = 'CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    'close-position-event': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON position_events
      WHEN NEW.event_type = 'HIT_TP2' BEGIN SELECT nexora_test_crash(); END`,
    'close-trade': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON trades
      BEGIN SELECT nexora_test_crash(); END`,
    'close-entry-snapshot': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON trade_snapshots
      WHEN NEW.snapshot_type = 'ENTRY' BEGIN SELECT nexora_test_crash(); END`,
    'close-tp1-snapshot': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON trade_snapshots
      WHEN NEW.snapshot_type = 'TP1' BEGIN SELECT nexora_test_crash(); END`,
    'close-close-snapshot': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON trade_snapshots
      WHEN NEW.snapshot_type = 'CLOSE' BEGIN SELECT nexora_test_crash(); END`,
    'close-signal': `CREATE TRIGGER test_close_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    'close-ledger': `CREATE TRIGGER test_close_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'REALIZED_EXIT_NET' BEGIN SELECT nexora_test_crash(); END`,
  };
  const key = `${group}-${point}`;
  if (!Object.hasOwn(triggerByPoint, key)) throw new Error('Unsupported lifecycle crash point.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(triggerByPoint[key]);
  const transitionAt = new Date(group === 'tp1' ? '2026-09-21T12:01:01.000Z' : '2026-09-21T12:02:01.000Z');
  const quote = group === 'tp1'
    ? { source: 'BROKER', dataFreshness: 'FRESH', bid: 2656.2, ask: 2656.4 }
    : { source: 'BROKER', dataFreshness: 'FRESH', bid: 2659.2, ask: 2659.4 };
  reconcilePaperExecution(db, {
    quote: { ...quote, observedAt: transitionAt.toISOString(), receivedAt: transitionAt.toISOString() },
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: transitionAt,
  });
  db.close();
  process.exit(0);
} else if (phase.startsWith('manual-close-crash-')) {
  const point = phase.slice('manual-close-crash-'.length);
  const triggerByPoint = {
    audit: `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_POSITION_MANUALLY_CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    position: `CREATE TRIGGER test_manual_close_crashpoint AFTER UPDATE ON positions
      WHEN NEW.status = 'CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    'position-event': `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON position_events
      WHEN NEW.event_type = 'MANUAL_CLOSE' BEGIN SELECT nexora_test_crash(); END`,
    trade: `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON trades
      BEGIN SELECT nexora_test_crash(); END`,
    'entry-snapshot': `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON trade_snapshots
      WHEN NEW.snapshot_type = 'ENTRY' BEGIN SELECT nexora_test_crash(); END`,
    'close-snapshot': `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON trade_snapshots
      WHEN NEW.snapshot_type = 'CLOSE' BEGIN SELECT nexora_test_crash(); END`,
    signal: `CREATE TRIGGER test_manual_close_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'CLOSED' BEGIN SELECT nexora_test_crash(); END`,
    ledger: `CREATE TRIGGER test_manual_close_crashpoint AFTER INSERT ON ledger_entries
      WHEN NEW.entry_type = 'REALIZED_EXIT_NET' BEGIN SELECT nexora_test_crash(); END`,
  };
  if (!Object.hasOwn(triggerByPoint, point)) throw new Error('Unsupported manual-close crash point.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(triggerByPoint[point]);
  const closeAt = new Date('2026-09-21T12:02:01.000Z');
  const quote = {
    source: 'BROKER', dataFreshness: 'FRESH', bid: 2651, ask: 2651.2,
    observedAt: closeAt.toISOString(), receivedAt: closeAt.toISOString(),
  };
  const positionId = db.prepare("SELECT id FROM positions WHERE status IN ('OPEN', 'PARTIAL') LIMIT 1").get()?.id;
  closePaperPosition(db, { positionId, quote, costs: {
    slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
    fillRatio: 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
    breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
  }, now: closeAt });
  db.close();
  process.exit(0);
} else if (phase.startsWith('sl-crash-')) {
  const variant = phase.slice('sl-crash-'.length);
  if (!['direct', 'after-tp1'].includes(variant)) throw new Error('Unsupported stop-close crash variant.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(`CREATE TRIGGER test_sl_crashpoint AFTER INSERT ON ledger_entries
    WHEN NEW.entry_type = 'REALIZED_EXIT_NET' BEGIN SELECT nexora_test_crash(); END`);
  const closeAt = new Date(variant === 'direct' ? '2026-09-21T12:00:02.000Z' : '2026-09-21T12:02:01.000Z');
  const quote = variant === 'direct'
    ? { source: 'BROKER', dataFreshness: 'FRESH', bid: 2646.9, ask: 2647.1 }
    : { source: 'BROKER', dataFreshness: 'FRESH', bid: 2650, ask: 2650.2 };
  reconcilePaperExecution(db, {
    quote: { ...quote, observedAt: closeAt.toISOString(), receivedAt: closeAt.toISOString() },
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: closeAt,
  });
  db.close();
  process.exit(0);
} else if (phase.startsWith('remainder-cancel-crash-')) {
  const point = phase.slice('remainder-cancel-crash-'.length);
  const triggerByPoint = {
    audit: `CREATE TRIGGER test_remainder_cancel_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_ORDER_REMAINDER_CANCELLED' BEGIN SELECT nexora_test_crash(); END`,
    order: `CREATE TRIGGER test_remainder_cancel_crashpoint AFTER UPDATE ON orders
      WHEN NEW.status = 'CANCELLED' BEGIN SELECT nexora_test_crash(); END`,
  };
  if (!Object.hasOwn(triggerByPoint, point)) throw new Error('Unsupported remainder-cancel crash point.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(triggerByPoint[point]);
  const tp1At = new Date('2026-09-21T12:01:01.000Z');
  reconcilePaperExecution(db, {
    quote: {
      source: 'BROKER', dataFreshness: 'FRESH', bid: 2656.2, ask: 2656.4,
      observedAt: tp1At.toISOString(), receivedAt: tp1At.toISOString(),
    },
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: 0.5, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: tp1At,
  });
  db.close();
  process.exit(0);
} else if (phase.startsWith('expiry-crash-') || phase.startsWith('paper-off-crash-')) {
  const group = phase.startsWith('expiry-crash-') ? 'expiry' : 'paper-off';
  const point = phase.slice(`${group}-crash-`.length);
  const triggerByPoint = {
    'expiry-audit': `CREATE TRIGGER test_expiry_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_ORDER_EXPIRED' BEGIN SELECT nexora_test_crash(); END`,
    'expiry-order': `CREATE TRIGGER test_expiry_crashpoint AFTER UPDATE ON orders
      WHEN NEW.status = 'EXPIRED' BEGIN SELECT nexora_test_crash(); END`,
    'expiry-signal': `CREATE TRIGGER test_expiry_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'EXPIRED' BEGIN SELECT nexora_test_crash(); END`,
    'paper-off-audit': `CREATE TRIGGER test_paper_off_crashpoint AFTER INSERT ON audit_events
      WHEN NEW.event_type = 'PAPER_ORDER_CANCELLED' BEGIN SELECT nexora_test_crash(); END`,
    'paper-off-order': `CREATE TRIGGER test_paper_off_crashpoint AFTER UPDATE ON orders
      WHEN NEW.status = 'CANCELLED' BEGIN SELECT nexora_test_crash(); END`,
    'paper-off-signal': `CREATE TRIGGER test_paper_off_crashpoint AFTER UPDATE ON signals
      WHEN NEW.status = 'CANCELLED' BEGIN SELECT nexora_test_crash(); END`,
  };
  const key = `${group}-${point}`;
  if (!Object.hasOwn(triggerByPoint, key)) throw new Error('Unsupported pending-order crash point.');
  db.function('nexora_test_crash', () => process.exit(86));
  db.exec(triggerByPoint[key]);
  const transitionAt = new Date('2026-09-21T12:00:02.000Z');
  reconcilePaperExecution(db, {
    quote: null,
    paperMode: group !== 'paper-off',
    costs: {
      slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
      fillRatio: 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
      breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
    },
    now: transitionAt,
  });
  db.close();
  process.exit(0);
} else {
  throw new Error('Unsupported test phase.');
}

process.stdout.write('READY\n');
setInterval(() => {}, 1000);
