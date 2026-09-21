import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, readState, writeState } from '../src/database.mjs';
import { initializeDatabase } from '../src/server.mjs';
import { closePaperPosition, reconcilePaperExecution } from '../src/services/paper-lifecycle-service.mjs';
import { persistScanResult } from '../src/services/paper-scan-service.mjs';

const childPath = fileURLToPath(new URL('./crash-recovery-child.mjs', import.meta.url));
const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const logicalKey = 'XAUUSD:M15:crash-fixture:mtf-paper-v1';
const fillCosts = {
  slippagePrice: 0.1, commissionPerLot: 2, swapPerLotPerDay: 1, fillLatencyMs: 250,
  fillRatio: 1, contractSize: 100, quoteToAccountRate: 1, lotStep: 0.1, minimumLot: 0.1,
  breakEvenOffsetPrice: 0.05, accountCurrency: 'USD',
};

function brokerQuote(at, bid, ask) {
  const iso = at.toISOString();
  return { source: 'BROKER', dataFreshness: 'FRESH', bid, ask, observedAt: iso, receivedAt: iso };
}

function stagePaperLong(db, createdAt, logicalSuffix, lots = 0.2) {
  return persistScanResult(db, {
    status: 'ORDER_STAGED', accepted: true, direction: 'LONG', score: 82, confluencePct: 75,
    plan: { orderType: 'LIMIT', entry: 2650, stop: 2647, takeProfit1: 2656, takeProfit2: 2659, riskReward: 2, expiresAfterMinutes: 120 },
    sizing: { lots, riskAmount: 30 },
    analyses: [{ timeframe: 'M15', direction: 'LONG', strength: 0.8, votes: [], indicators: {}, rejectionReasons: [], candleClosedAt: createdAt.toISOString() }],
    snapshots: {
      configVersion: 'mtf-paper-v1', account: { equity: 10_000, currency: 'USD' },
      market: { source: 'BROKER', quote: { bid: 2650, ask: 2650.2 } }, risk: { allowed: true },
    },
  }, { logicalKey: `${logicalKey}:${logicalSuffix}`, now: createdAt });
}

async function runCrashChild(databasePath, phase) {
  const child = spawn(process.execPath, [childPath, databasePath, phase], {
    cwd: process.cwd(),
    env: {
      ...process.env, LIVE_TRADING_ENABLED: 'false', NEXORA_HOST: '127.0.0.1',
      PAPER_MODE: 'true', NEXORA_CONTROL_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timer;
  const exit = await Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
  ]);
  clearTimeout(timer);
  if (!exit) {
    const forcedExit = once(child, 'exit');
    child.kill('SIGKILL');
    await forcedExit;
    assert.fail(`${phase} crash point was not reached; stdout=${stdout}; stderr=${stderr}`);
  }
  assert.equal(exit.code, 86, `${phase} should terminate at its injected SQLite boundary (signal=${exit.signal}; stdout=${stdout}; stderr=${stderr})`);
}

function seedOpenPosition(databasePath, migrationsDirectory, suffix, includeTp1 = false) {
  const db = openDatabase(databasePath, migrationsDirectory);
  const createdAt = new Date('2026-09-21T12:00:00.000Z');
  initializeDatabase(db, createdAt);
  writeState(db, 'riskMetrics', {
    equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
  }, createdAt.toISOString());
  const staged = stagePaperLong(db, createdAt, suffix);
  assert.equal(staged.status, 'ORDER_STAGED');
  const fillAt = new Date('2026-09-21T12:00:01.000Z');
  const filled = reconcilePaperExecution(db, {
    quote: brokerQuote(fillAt, 2649.7, 2649.9), costs: fillCosts, now: fillAt,
  });
  assert.equal(filled.filled, 1);
  if (includeTp1) {
    const tp1At = new Date('2026-09-21T12:01:01.000Z');
    const tp1 = reconcilePaperExecution(db, {
      quote: brokerQuote(tp1At, 2656.2, 2656.4), costs: fillCosts, now: tp1At,
    });
    assert.equal(tp1.monitored, 1);
    assert.equal(db.prepare("SELECT status FROM positions WHERE order_id = (SELECT id FROM orders LIMIT 1)").get().status, 'PARTIAL');
  }
  db.close();
}

async function startChild(databasePath, phase) {
  const child = spawn(process.execPath, [childPath, databasePath, phase], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LIVE_TRADING_ENABLED: 'false',
      NEXORA_HOST: '127.0.0.1',
      PAPER_MODE: 'true',
      NEXORA_CONTROL_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Crash fixture process did not become ready.')), 15_000);
    child.stdout.on('data', (chunk) => {
      if ((stdout + chunk).includes('READY\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Crash fixture exited before ready (${code ?? signal}): ${stderr}`));
    });
  });
  await ready;
  return child;
}

async function killAbruptly(child) {
  child.kill();
  await once(child, 'exit');
}

test('committed logical order survives process termination and duplicate replay after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-commit-'));
  const databasePath = join(directory, 'nexora.sqlite');
  let db;
  try {
    const child = await startChild(databasePath, 'committed-order');
    await killAbruptly(child);

    db = openDatabase(databasePath, migrations);
    initializeDatabase(db, new Date('2026-09-21T12:01:00.000Z'));
    assert.equal(readState(db, 'paperMode'), true);
    assert.equal(readState(db, 'entryPaused'), true, 'restart must force entries back to paused');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'PENDING'").get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM signals').get().count, 1);

    const replay = persistScanResult(db, {
      accepted: true,
      direction: 'LONG',
      plan: { orderType: 'LIMIT', entry: 2650, stop: 2647, takeProfit1: 2656, takeProfit2: 2659 },
      sizing: { lots: 0.1, riskAmount: 30 },
    }, { logicalKey, now: new Date('2026-09-21T12:02:00.000Z') });
    assert.equal(replay.replayed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'PENDING'").get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE event_type = ?').get('PAPER_ORDER_STAGED').count, 1);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('order, audit, and state writes inside an uncommitted transaction roll back after process termination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-rollback-'));
  const databasePath = join(directory, 'nexora.sqlite');
  let db;
  try {
    const child = await startChild(databasePath, 'uncommitted-order');
    await killAbruptly(child);

    db = openDatabase(databasePath, migrations);
    initializeDatabase(db, new Date('2026-09-21T12:01:00.000Z'));
    assert.equal(readState(db, 'entryPaused'), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scan_runs').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM signals').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('paper fill crash points roll back atomically and recover as one logical fill after restart', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-fill-'));
  const crashPoints = [
    'audit', 'position', 'order', 'signal', 'position-event', 'ledger',
  ];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      const createdAt = new Date('2026-09-21T12:00:00.000Z');
      let db = openDatabase(databasePath, migrations);
      initializeDatabase(db, createdAt);
      writeState(db, 'riskMetrics', {
        equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
      }, createdAt.toISOString());
      const staged = persistScanResult(db, {
        status: 'ORDER_STAGED', accepted: true, direction: 'LONG', score: 82, confluencePct: 75,
        plan: { orderType: 'LIMIT', entry: 2650, stop: 2647, takeProfit1: 2656, takeProfit2: 2659, riskReward: 2, expiresAfterMinutes: 120 },
        sizing: { lots: 0.1, riskAmount: 30 },
        analyses: [{ timeframe: 'M15', direction: 'LONG', strength: 0.8, votes: [], indicators: {}, rejectionReasons: [], candleClosedAt: createdAt.toISOString() }],
        snapshots: {
          configVersion: 'mtf-paper-v1', account: { equity: 10_000, currency: 'USD' },
          market: { source: 'BROKER', quote: { bid: 2650, ask: 2650.2 } }, risk: { allowed: true },
        },
      }, { logicalKey: `${logicalKey}:${point}`, now: createdAt });
      assert.equal(staged.status, 'ORDER_STAGED', `seed pending order at ${point}`);
      db.close();

      await runCrashChild(databasePath, `fill-crash-${point}`);

      db = openDatabase(databasePath, migrations);
      initializeDatabase(db, new Date('2026-09-21T12:00:01.000Z'));
      assert.equal(db.prepare("SELECT status FROM orders WHERE status IN ('PENDING', 'PARTIAL')").get()?.status, 'PENDING', `${point}: order remains pending after rollback`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0, `${point}: no orphan position`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_FILLED'").get().n, 0, `${point}: no partial fill audit`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'FILL'").get().n, 0, `${point}: no partial lifecycle event`);
      db.exec('DROP TRIGGER IF EXISTS test_fill_crashpoint');

      const fillAt = new Date('2026-09-21T12:00:02.000Z');
      const quote = {
        source: 'BROKER', dataFreshness: 'FRESH', bid: 2649.7, ask: 2649.9,
        observedAt: fillAt.toISOString(), receivedAt: fillAt.toISOString(),
      };
      const recovered = reconcilePaperExecution(db, { quote, costs: fillCosts, now: fillAt });
      assert.equal(recovered.filled, 1, `${point}: one recovered fill`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 1, `${point}: one position after recovery`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_FILLED'").get().n, 1, `${point}: one fill audit after recovery`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'FILL'").get().n, 1, `${point}: one fill event after recovery`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 1, `${point}: one commission entry after recovery`);
      const replay = reconcilePaperExecution(db, { quote, costs: fillCosts, now: fillAt });
      assert.equal(replay.filled, 0, `${point}: replay cannot create a second logical fill`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 1, `${point}: position remains singular on replay`);
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial-fill crash points roll back atomically and replay each quote observation once', { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-partial-fill-'));
  const crashPoints = ['audit', 'position', 'order', 'signal', 'position-event', 'ledger'];
  const partialCosts = { ...fillCosts, fillRatio: 0.5 };
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      const createdAt = new Date('2026-09-21T12:00:00.000Z');
      let db = openDatabase(databasePath, migrations);
      initializeDatabase(db, createdAt);
      writeState(db, 'riskMetrics', {
        equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
      }, createdAt.toISOString());
      assert.equal(stagePaperLong(db, createdAt, `partial-fill-${point}`).status, 'ORDER_STAGED');
      db.close();

      await runCrashChild(databasePath, `partial-fill-crash-${point}`);
      db = openDatabase(databasePath, migrations);
      try {
        initializeDatabase(db, new Date('2026-09-21T12:00:01.000Z'));
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PENDING', `${point}: partial fill order rolls back`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0, `${point}: no partial position survives`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_PARTIALLY_FILLED'").get().n, 0, `${point}: partial fill audit rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'PARTIAL_FILL'").get().n, 0, `${point}: partial-fill event rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 0, `${point}: partial commission rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_partial_fill_crashpoint');

        const fillAt = new Date('2026-09-21T12:00:02.000Z');
        const quote = brokerQuote(fillAt, 2649.7, 2649.9);
        const recovered = reconcilePaperExecution(db, { quote, costs: partialCosts, now: fillAt });
        assert.equal(recovered.filled, 1, `${point}: partial fill recovers once`);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PARTIAL');
        assert.equal(Number(db.prepare('SELECT remaining_quantity_lots FROM orders LIMIT 1').get().remaining_quantity_lots), 0.1);
        assert.equal(Number(db.prepare('SELECT quantity_open_lots FROM positions LIMIT 1').get().quantity_open_lots), 0.1);

        const replay = reconcilePaperExecution(db, { quote, costs: partialCosts, now: fillAt });
        assert.equal(replay.filled, 0, `${point}: the same quote cannot create another partial fill`);
        assert.ok(replay.reasons.includes('QUOTE_ALREADY_MATCHED'));
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'PARTIAL_FILL'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 1);

        const nextAt = new Date('2026-09-21T12:00:03.000Z');
        const next = reconcilePaperExecution(db, {
          quote: brokerQuote(nextAt, 2649.7, 2649.9), costs: partialCosts, now: nextAt,
        });
        assert.equal(next.filled, 1, `${point}: valid remaining minimum lot fills on the next quote`);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'FILLED');
        assert.equal(Number(db.prepare('SELECT quantity_initial_lots FROM positions LIMIT 1').get().quantity_initial_lots), 0.2);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type IN ('PARTIAL_FILL', 'FILL')").get().n, 2);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 2);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('committed partial fill survives process restart without matching the same quote twice', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-committed-partial-fill-'));
  const databasePath = join(directory, 'nexora.sqlite');
  const createdAt = new Date('2026-09-21T12:00:00.000Z');
  const partialCosts = { ...fillCosts, fillRatio: 0.5 };
  let db;
  try {
    db = openDatabase(databasePath, migrations);
    initializeDatabase(db, createdAt);
    writeState(db, 'riskMetrics', {
      equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
    }, createdAt.toISOString());
    assert.equal(stagePaperLong(db, createdAt, 'committed-partial-fill').status, 'ORDER_STAGED');
    db.close();
    db = null;

    const child = await startChild(databasePath, 'committed-partial-fill');
    await killAbruptly(child);

    db = openDatabase(databasePath, migrations);
    const restartAt = new Date('2026-09-21T12:00:03.000Z');
    initializeDatabase(db, restartAt);
    assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PARTIAL');
    assert.equal(Number(db.prepare('SELECT quantity_open_lots FROM positions LIMIT 1').get().quantity_open_lots), 0.1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_PARTIALLY_FILLED'").get().n, 1);

    const fillAt = new Date('2026-09-21T12:00:02.000Z');
    const quote = brokerQuote(fillAt, 2649.7, 2649.9);
    const replay = reconcilePaperExecution(db, { quote, costs: partialCosts, now: restartAt });
    assert.equal(replay.filled, 0);
    assert.ok(replay.reasons.includes('QUOTE_ALREADY_MATCHED'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'PARTIAL_FILL'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 1);

    const nextAt = new Date('2026-09-21T12:00:04.000Z');
    const next = reconcilePaperExecution(db, {
      quote: brokerQuote(nextAt, 2649.7, 2649.9), costs: partialCosts, now: nextAt,
    });
    assert.equal(next.filled, 1);
    assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'FILLED');
    assert.equal(Number(db.prepare('SELECT quantity_initial_lots FROM positions LIMIT 1').get().quantity_initial_lots), 0.2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'ENTRY_COMMISSION'").get().n, 2);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('TP1 remainder-cancel crashes roll back partial position and order, then recover once', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-remainder-cancel-'));
  const partialCosts = { ...fillCosts, fillRatio: 0.5 };
  try {
    for (const point of ['audit', 'order']) {
      const databasePath = join(directory, `${point}.sqlite`);
      const createdAt = new Date('2026-09-21T12:00:00.000Z');
      let db = openDatabase(databasePath, migrations);
      initializeDatabase(db, createdAt);
      writeState(db, 'riskMetrics', {
        equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 1,
      }, createdAt.toISOString());
      assert.equal(stagePaperLong(db, createdAt, `remainder-cancel-${point}`).status, 'ORDER_STAGED');
      const fillAt = new Date('2026-09-21T12:00:02.000Z');
      assert.equal(reconcilePaperExecution(db, {
        quote: brokerQuote(fillAt, 2649.7, 2649.9), costs: partialCosts, now: fillAt,
      }).filled, 1);
      assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PARTIAL');
      db.close();

      await runCrashChild(databasePath, `remainder-cancel-crash-${point}`);
      db = openDatabase(databasePath, migrations);
      try {
        const tp1At = new Date('2026-09-21T12:01:01.000Z');
        initializeDatabase(db, tp1At);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'OPEN', `${point}: TP1 position transition rolls back`);
        assert.equal(db.prepare('SELECT tp1_hit FROM positions LIMIT 1').get().tp1_hit, 0);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PARTIAL', `${point}: pending remainder rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_REMAINDER_CANCELLED'").get().n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 0);
        db.exec('DROP TRIGGER IF EXISTS test_remainder_cancel_crashpoint');

        const quote = brokerQuote(tp1At, 2656.2, 2656.4);
        const recovered = reconcilePaperExecution(db, { quote, costs: partialCosts, now: tp1At });
        assert.equal(recovered.monitored, 1, `${point}: TP1 and remainder cancellation recover once`);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'PARTIAL');
        assert.equal(db.prepare('SELECT tp1_hit FROM positions LIMIT 1').get().tp1_hit, 1);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'CANCELLED');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_REMAINDER_CANCELLED'").get().n, 1);

        reconcilePaperExecution(db, { quote, costs: partialCosts, now: tp1At });
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_REMAINDER_CANCELLED'").get().n, 1);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TP1 partial-close crashes roll back all transition writes and replay exactly once after restart', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-tp1-'));
  const crashPoints = ['audit', 'position', 'position-event', 'gross-ledger', 'commission-ledger', 'signal'];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      seedOpenPosition(databasePath, migrations, `tp1-${point}`);
      await runCrashChild(databasePath, `tp1-crash-${point}`);

      const db = openDatabase(databasePath, migrations);
      try {
        initializeDatabase(db, new Date('2026-09-21T12:01:02.000Z'));
        const state = db.prepare('SELECT * FROM positions LIMIT 1').get();
        assert.equal(state.status, 'OPEN', `${point}: position status rolls back`);
        assert.equal(state.tp1_hit, 0, `${point}: TP1 marker rolls back`);
        assert.equal(db.prepare("SELECT status FROM signals LIMIT 1").get().status, 'OPEN', `${point}: signal remains open`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 0, `${point}: TP1 event rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_UPDATED'").get().n, 0, `${point}: transition audit rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type IN ('REALIZED_PARTIAL_GROSS', 'EXIT_COMMISSION')").get().n, 0, `${point}: partial-close ledger rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_tp1_crashpoint');

        const tp1At = new Date('2026-09-21T12:01:01.000Z');
        const quote = brokerQuote(tp1At, 2656.2, 2656.4);
        const recovered = reconcilePaperExecution(db, { quote, costs: fillCosts, now: tp1At });
        assert.equal(recovered.monitored, 1, `${point}: transition recovers`);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'PARTIAL');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_PARTIAL_GROSS'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'EXIT_COMMISSION'").get().n, 1);
        const replay = reconcilePaperExecution(db, { quote, costs: fillCosts, now: tp1At });
        assert.equal(replay.monitored, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP1'").get().n, 1, `${point}: no duplicate TP1`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TP2 close crashes roll back trade, snapshots, position, audit, and ledger before one recovery close', { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-close-'));
  const crashPoints = ['audit', 'position', 'position-event', 'trade', 'entry-snapshot', 'tp1-snapshot', 'close-snapshot', 'signal', 'ledger'];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      seedOpenPosition(databasePath, migrations, `close-${point}`, true);
      await runCrashChild(databasePath, `close-crash-${point}`);

      const db = openDatabase(databasePath, migrations);
      try {
        initializeDatabase(db, new Date('2026-09-21T12:02:02.000Z'));
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'PARTIAL', `${point}: partial position rolls back to pre-close state`);
        assert.equal(db.prepare('SELECT tp1_hit FROM positions LIMIT 1').get().tp1_hit, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, `${point}: no incomplete closed trade`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_snapshots').get().n, 0, `${point}: trade snapshots roll back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP2'").get().n, 0, `${point}: close event rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_CLOSED'").get().n, 0, `${point}: close audit rolls back`);
        assert.equal(db.prepare("SELECT status FROM signals LIMIT 1").get().status, 'PARTIAL', `${point}: signal remains partial`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_EXIT_NET'").get().n, 0, `${point}: close ledger rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_close_crashpoint');

        const closeAt = new Date('2026-09-21T12:02:01.000Z');
        const quote = brokerQuote(closeAt, 2659.2, 2659.4);
        const recovered = reconcilePaperExecution(db, { quote, costs: fillCosts, now: closeAt });
        assert.equal(recovered.closed, 1, `${point}: close recovers once`);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'CLOSED');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_snapshots').get().n, 3);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'HIT_TP2'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_CLOSED'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_EXIT_NET'").get().n, 1);
        const replay = reconcilePaperExecution(db, { quote, costs: fillCosts, now: closeAt });
        assert.equal(replay.closed, 0, `${point}: closed transition is idempotent`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending expiry crashes roll back order, signal, and audit before one expiry after restart', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-expiry-'));
  const crashPoints = ['audit', 'order', 'signal'];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      let db = openDatabase(databasePath, migrations);
      const createdAt = new Date('2026-09-21T12:00:00.000Z');
      initializeDatabase(db, createdAt);
      const staged = stagePaperLong(db, createdAt, `expiry-${point}`);
      const expiredAt = new Date('2026-09-21T12:00:01.000Z').toISOString();
      const orderId = db.prepare('SELECT id FROM orders LIMIT 1').get().id;
      db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run(expiredAt, orderId);
      db.close();

      await runCrashChild(databasePath, `expiry-crash-${point}`);
      db = openDatabase(databasePath, migrations);
      try {
        initializeDatabase(db, new Date('2026-09-21T12:00:02.000Z'));
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PENDING', `${point}: order expiry rolls back`);
        assert.equal(db.prepare('SELECT status FROM signals LIMIT 1').get().status, 'PENDING', `${point}: signal remains pending`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_EXPIRED'").get().n, 0, `${point}: expiry audit rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_expiry_crashpoint');

        const now = new Date('2026-09-21T12:00:02.000Z');
        const recovered = reconcilePaperExecution(db, { quote: null, costs: fillCosts, now });
        assert.equal(recovered.expired, 1, `${point}: order expires after recovery`);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'EXPIRED');
        assert.equal(db.prepare('SELECT status FROM signals LIMIT 1').get().status, 'EXPIRED');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_EXPIRED'").get().n, 1);
        const replay = reconcilePaperExecution(db, { quote: null, costs: fillCosts, now });
        assert.equal(replay.expired, 0, `${point}: no duplicate expiry`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PAPER OFF cancellation crashes roll back order, signal, and audit before one cancellation after restart', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-paper-off-'));
  const crashPoints = ['audit', 'order', 'signal'];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      let db = openDatabase(databasePath, migrations);
      const createdAt = new Date('2026-09-21T12:00:00.000Z');
      initializeDatabase(db, createdAt);
      stagePaperLong(db, createdAt, `paper-off-${point}`);
      db.close();

      await runCrashChild(databasePath, `paper-off-crash-${point}`);
      db = openDatabase(databasePath, migrations);
      try {
        initializeDatabase(db, new Date('2026-09-21T12:00:02.000Z'));
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'PENDING', `${point}: order cancellation rolls back`);
        assert.equal(db.prepare('SELECT status FROM signals LIMIT 1').get().status, 'PENDING', `${point}: signal remains pending`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_CANCELLED'").get().n, 0, `${point}: cancellation audit rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_paper_off_crashpoint');

        const now = new Date('2026-09-21T12:00:02.000Z');
        const recovered = reconcilePaperExecution(db, { quote: null, costs: fillCosts, paperMode: false, now });
        assert.equal(recovered.cancelled, 1, `${point}: pending order cancels after recovery`);
        assert.equal(db.prepare('SELECT status FROM orders LIMIT 1').get().status, 'CANCELLED');
        assert.equal(db.prepare('SELECT status FROM signals LIMIT 1').get().status, 'CANCELLED');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_ORDER_CANCELLED'").get().n, 1);
        const replay = reconcilePaperExecution(db, { quote: null, costs: fillCosts, paperMode: false, now });
        assert.equal(replay.cancelled, 0, `${point}: no duplicate cancellation`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct-SL and post-TP1 stop closes recover once after a process crash', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-stop-'));
  const cases = [
    { name: 'direct', includeTp1: false, expectedReason: 'SL_DIRECT', at: '2026-09-21T12:00:02.000Z', bid: 2646.9, ask: 2647.1, preCloseState: 'OPEN' },
    { name: 'after-tp1', includeTp1: true, expectedReason: 'SL_AFTER_TP1', at: '2026-09-21T12:02:01.000Z', bid: 2650, ask: 2650.2, preCloseState: 'PARTIAL' },
  ];
  try {
    for (const item of cases) {
      const databasePath = join(directory, `${item.name}.sqlite`);
      seedOpenPosition(databasePath, migrations, `stop-${item.name}`, item.includeTp1);
      await runCrashChild(databasePath, `sl-crash-${item.name}`);
      const db = openDatabase(databasePath, migrations);
      try {
        const closeAt = new Date(item.at);
        initializeDatabase(db, closeAt);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, item.preCloseState, `${item.name}: position remains at pre-close state`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, `${item.name}: crashed close has no trade`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_CLOSED'").get().n, 0, `${item.name}: close audit rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_sl_crashpoint');

        const quote = brokerQuote(closeAt, item.bid, item.ask);
        const recovered = reconcilePaperExecution(db, { quote, costs: fillCosts, now: closeAt });
        assert.equal(recovered.closed, 1, `${item.name}: stop close recovers`);
        const trade = db.prepare('SELECT * FROM trades LIMIT 1').get();
        assert.equal(trade.close_reason, item.expectedReason);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = ?").get(item.expectedReason).n, 1);
        const replay = reconcilePaperExecution(db, { quote, costs: fillCosts, now: closeAt });
        assert.equal(replay.closed, 0, `${item.name}: replay does not close twice`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual paper close recovers atomically at every persisted boundary after process crash', { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexora-crash-manual-close-'));
  const crashPoints = ['audit', 'position', 'position-event', 'trade', 'entry-snapshot', 'close-snapshot', 'signal', 'ledger'];
  try {
    for (const point of crashPoints) {
      const databasePath = join(directory, `${point}.sqlite`);
      seedOpenPosition(databasePath, migrations, `manual-close-${point}`);
      await runCrashChild(databasePath, `manual-close-crash-${point}`);

      const db = openDatabase(databasePath, migrations);
      try {
        const closeAt = new Date('2026-09-21T12:02:01.000Z');
        initializeDatabase(db, closeAt);
        const position = db.prepare('SELECT * FROM positions LIMIT 1').get();
        assert.equal(position.status, 'OPEN', `${point}: open position rolls back`);
        assert.equal(position.close_reason, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, `${point}: no incomplete trade`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_snapshots').get().n, 0, `${point}: snapshots roll back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'MANUAL_CLOSE'").get().n, 0, `${point}: close event rolls back`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_MANUALLY_CLOSED'").get().n, 0, `${point}: close audit rolls back`);
        assert.equal(db.prepare('SELECT status FROM signals LIMIT 1').get().status, 'OPEN', `${point}: signal stays open`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_EXIT_NET'").get().n, 0, `${point}: net ledger rolls back`);
        db.exec('DROP TRIGGER IF EXISTS test_manual_close_crashpoint');

        const quote = brokerQuote(closeAt, 2651, 2651.2);
        const recovered = closePaperPosition(db, { positionId: position.id, quote, costs: fillCosts, now: closeAt });
        assert.equal(recovered.closed, true, `${point}: manual close recovers once`);
        assert.equal(db.prepare('SELECT status FROM positions LIMIT 1').get().status, 'CLOSED');
        assert.equal(db.prepare('SELECT close_reason FROM trades LIMIT 1').get().close_reason, 'MANUAL_CLOSE');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM position_events WHERE event_type = 'MANUAL_CLOSE'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'PAPER_POSITION_MANUALLY_CLOSED'").get().n, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE entry_type = 'REALIZED_EXIT_NET'").get().n, 1);
        const replay = closePaperPosition(db, { positionId: position.id, quote, costs: fillCosts, now: closeAt });
        assert.equal(replay.reason, 'POSITION_NOT_OPEN', `${point}: replay is safely rejected`);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 1, `${point}: no duplicate trade`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
