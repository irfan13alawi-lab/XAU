import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { appendAudit, openDatabase, readState, writeState } from '../src/database.mjs';
import { initializeDatabase, createNexoraServer, validLocalHost, handleTelegramCommand, dashboardSnapshot } from '../src/server.mjs';
import { PaperWorker } from '../src/worker.mjs';
import { activeSessions } from '../src/domain/market-sessions.mjs';
import { config, fingerprintConfiguration } from '../src/config.mjs';

let db;
let server;
let origin;
const CONTROL_TOKEN = 'test-only-local-control-token-for-api-tests-2026';

test('dashboard enables paper entries only when every readiness gate and worker heartbeat are fresh', () => {
  const now = new Date('2026-09-21T00:00:00.000Z');
  const telemetryDb = openDatabase(':memory:', fileURLToPath(new URL('../src/migrations/', import.meta.url)));
  initializeDatabase(telemetryDb, now);
  const at = now.toISOString();
  try {
    writeState(telemetryDb, 'paperMode', true, at);
    writeState(telemetryDb, 'entryPaused', false, at);
    writeState(telemetryDb, 'worker', { running: true, heartbeatAt: at }, at);
    writeState(telemetryDb, 'newsProvider', { status: 'HEALTHY', source: 'test-calendar', fetchedAt: at }, at);
    writeState(telemetryDb, 'riskMetrics', {
      equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0,
    }, at);
    telemetryDb.prepare(`INSERT INTO broker_health (source, status, checked_at, details_json) VALUES (?, 'HEALTHY', ?, ?)`)
      .run('test-provider', at, JSON.stringify({ reason: null }));
    telemetryDb.prepare(`
      INSERT INTO market_snapshots (id, symbol, source, status, bid, ask, last, observed_at, received_at, details_json)
      VALUES (?, 'XAUUSD', 'BROKER', 'BROKER', '2500.00', '2500.50', '2500.25', ?, ?, '{}')
    `).run('fresh-test-quote', at, at);
    telemetryDb.prepare(`
      INSERT INTO candles (symbol, timeframe, closed_at, open_price, high_price, low_price, close_price, tick_volume, source, quality)
      VALUES ('XAUUSD', 'M15', ?, '2500.00', '2501.00', '2499.00', '2500.50', 100, 'BROKER', 'VERIFIED_CLOSED')
    `).run(at);

    let snapshot = dashboardSnapshot(telemetryDb, now);
    assert.equal(snapshot.trading.state, 'PAPER ON');
    assert.equal(snapshot.trading.entriesAllowed, true);
    assert.equal(snapshot.worker.running, true);
    assert.ok(snapshot.trading.statusFlags.includes('PAPER ON'));
    assert.ok(snapshot.trading.statusFlags.includes('LIVE DISABLED'));

    writeState(telemetryDb, 'entryPaused', true, at);
    snapshot = dashboardSnapshot(telemetryDb, now);
    assert.equal(snapshot.trading.state, 'ENTRY PAUSED');
    assert.equal(snapshot.trading.entriesAllowed, false);

    writeState(telemetryDb, 'entryPaused', false, at);
    writeState(telemetryDb, 'worker', {
      running: true, heartbeatAt: '2026-09-21T00:00:01.000Z',
    }, at);
    snapshot = dashboardSnapshot(telemetryDb, now);
    assert.equal(snapshot.trading.state, 'PAPER CHECKING');
    assert.equal(snapshot.trading.entriesAllowed, false);
    assert.equal(snapshot.worker.running, false);

    writeState(telemetryDb, 'paperMode', false, at);
    writeState(telemetryDb, 'worker', { running: true, heartbeatAt: at }, at);
    snapshot = dashboardSnapshot(telemetryDb, now);
    assert.equal(snapshot.trading.state, 'MONITORING ONLY');
    assert.equal(snapshot.trading.paperModeState, 'PAPER OFF');
    assert.equal(snapshot.trading.operatingMode, 'MONITORING ONLY');
    assert.deepEqual(snapshot.trading.statusFlags, ['MONITORING ONLY', 'PAPER OFF', 'LIVE DISABLED']);

    telemetryDb.prepare('DELETE FROM broker_health').run();
    snapshot = dashboardSnapshot(telemetryDb, now);
    assert.equal(snapshot.trading.state, 'BROKER OFFLINE');
    assert.deepEqual(snapshot.trading.statusFlags, [
      'BROKER OFFLINE', 'PAPER OFF', 'MONITORING ONLY', 'LIVE DISABLED',
    ]);
  } finally {
    telemetryDb.close();
  }
});

before(async () => {
  db = openDatabase(':memory:', fileURLToPath(new URL('../src/migrations/', import.meta.url)));
  initializeDatabase(db, new Date('2026-09-21T00:00:00.000Z'));
  server = createNexoraServer({ db, clock: () => new Date('2026-09-21T00:00:00.000Z'), operatorToken: CONTROL_TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
});

test('health separates process liveness from market readiness', async () => {
  const response = await fetch(`${origin}/healthz`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.liveness, 'ok');
  assert.equal(body.readiness, 'not_ready');
  assert.ok(body.readinessReasons.includes('BROKER_OFFLINE'));
  assert.ok(body.readinessReasons.includes('RISK_STATE_NOT_FRESH'));
  assert.equal(body.database, 'connected');
  assert.equal(body.buildId, config.buildId);
  assert.notEqual(body.buildId, 'LOCAL-UNVERSIONED');
  assert.match(body.buildId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
  assert.equal(body.schemaVersion, 8);
  assert.equal(body.controlActionsAvailable, true);
  assert.equal(body.worker.lastTick, null);
});

test('HTTP responses expose request IDs and logs use safe low-cardinality fields', async () => {
  const records = [];
  const requestServer = createNexoraServer({
    db,
    clock: () => new Date('2026-09-21T00:00:00.000Z'),
    operatorToken: null,
    logger: { log: (line) => records.push(JSON.parse(line)) },
  });
  await new Promise((resolve) => requestServer.listen(0, '127.0.0.1', resolve));
  const requestOrigin = `http://127.0.0.1:${requestServer.address().port}`;
  try {
    const first = await fetch(`${requestOrigin}/api/dashboard?token=request-secret-sentinel`);
    const firstId = first.headers.get('x-request-id');
    assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(first.status, 200);

    const second = await fetch(`${requestOrigin}/api/not-a-real-route?token=request-secret-sentinel`);
    const secondId = second.headers.get('x-request-id');
    assert.match(secondId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(secondId, firstId);
    assert.equal(second.status, 404);

    assert.deepEqual(records.map(({ event, requestId, method, route, status }) => ({ event, requestId, method, route, status })), [
      { event: 'http_request_completed', requestId: firstId, method: 'GET', route: 'dashboard.api', status: 200 },
      { event: 'http_request_completed', requestId: secondId, method: 'GET', route: 'api.other', status: 404 },
    ]);
    assert.ok(records.every((record) => Number.isFinite(record.durationMs) && record.durationMs >= 0));
    assert.doesNotMatch(JSON.stringify(records), /request-secret-sentinel|token=/i);
  } finally {
    await new Promise((resolve, reject) => requestServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('unexpected API failures return a safe response and log only server-owned diagnostics', async () => {
  const failureMarker = 'NEXORA_INTERNAL_FAILURE_SENTINEL_DO_NOT_LEAK';
  const records = [];
  const throwingDb = { prepare() { throw new Error(failureMarker); } };
  const failureServer = createNexoraServer({
    db: throwingDb,
    operatorToken: null,
    logger: { log: (line) => records.push(JSON.parse(line)) },
  });
  await new Promise((resolve) => failureServer.listen(0, '127.0.0.1', resolve));
  const failureOrigin = `http://127.0.0.1:${failureServer.address().port}`;
  try {
    const response = await fetch(`${failureOrigin}/api/dashboard`, {
      headers: { 'x-request-id': 'caller-controlled-request-id' },
    });
    const body = await response.json();
    const requestId = response.headers.get('x-request-id');
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Request failed safely.' });
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(requestId, 'caller-controlled-request-id');
    assert.deepEqual(records.map(({ event, requestId: loggedId, method, route, status }) => ({
      event, requestId: loggedId, method, route, status,
    })), [{
      event: 'http_request_completed', requestId, method: 'GET', route: 'dashboard.api', status: 500,
    }]);
    assert.doesNotMatch(JSON.stringify({ body, records }), /NEXORA_INTERNAL_FAILURE_SENTINEL_DO_NOT_LEAK|caller-controlled-request-id/);
  } finally {
    await new Promise((resolve, reject) => failureServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('clock failures are contained by the request boundary without leaking diagnostics', async () => {
  const failureMarker = 'NEXORA_CLOCK_FAILURE_SENTINEL_DO_NOT_LEAK';
  const records = [];
  const clockFailureServer = createNexoraServer({
    db,
    clock: () => { throw new Error(failureMarker); },
    operatorToken: null,
    logger: { log: (line) => records.push(JSON.parse(line)) },
  });
  await new Promise((resolve) => clockFailureServer.listen(0, '127.0.0.1', resolve));
  const clockFailureOrigin = `http://127.0.0.1:${clockFailureServer.address().port}`;
  try {
    const response = await fetch(`${clockFailureOrigin}/healthz`);
    const body = await response.json();
    const requestId = response.headers.get('x-request-id');
    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Request failed safely.' });
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(records.map(({ event, requestId: loggedId, method, route, status }) => ({
      event, requestId: loggedId, method, route, status,
    })), [{
      event: 'http_request_completed', requestId, method: 'GET', route: 'unparsed', status: 500,
    }]);
    assert.doesNotMatch(JSON.stringify({ body, records }), /NEXORA_CLOCK_FAILURE_SENTINEL_DO_NOT_LEAK/);
  } finally {
    await new Promise((resolve, reject) => clockFailureServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('health reports bounded worker-cycle telemetry without forwarding arbitrary state', async () => {
  const previous = readState(db, 'worker');
  writeState(db, 'worker', {
    running: true,
    heartbeatAt: '2026-09-21T00:00:00.000Z',
    lastTick: {
      durationMs: 19.24,
      errorClass: 'SQLITE_IOERR',
      dependencies: {
        brokerHealth: { attempted: true, durationMs: 3.14, status: 'HEALTHY', token: 'must-not-leak' },
        marketData: { attempted: 1, durationMs: 700_000, status: 'UNTRUSTED_STATUS' },
        newsCalendar: { attempted: false, durationMs: null, status: 'CACHED' },
      },
      providerPayload: { secret: 'must-not-leak' },
    },
  }, '2026-09-21T00:00:00.000Z');
  try {
    const response = await fetch(`${origin}/healthz`);
    const body = await response.json();
    assert.deepEqual(body.worker.lastTick, {
      durationMs: 19.2,
      errorClass: 'SQLITE_IOERR',
      dependencies: {
        brokerHealth: { attempted: true, durationMs: 3.1, status: 'HEALTHY' },
        marketData: { attempted: false, durationMs: null, status: 'UNAVAILABLE' },
        newsCalendar: { attempted: false, durationMs: null, status: 'CACHED' },
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /must-not-leak|providerPayload|token/);
  } finally {
    writeState(db, 'worker', previous, '2026-09-21T00:00:00.000Z');
  }
});

test('worker cycle diagnostics flow through health and dashboard endpoints end to end', async () => {
  const now = new Date('2026-09-21T00:00:00.000Z');
  const telemetryDb = openDatabase(':memory:', fileURLToPath(new URL('../src/migrations/', import.meta.url)));
  initializeDatabase(telemetryDb, now);
  const telemetryServer = createNexoraServer({ db: telemetryDb, clock: () => now, operatorToken: null });
  await new Promise((resolve) => telemetryServer.listen(0, '127.0.0.1', resolve));
  const telemetryOrigin = `http://127.0.0.1:${telemetryServer.address().port}`;
  try {
    let monotonic = 0;
    const worker = new PaperWorker({ db: telemetryDb, clock: () => now, monotonicNow: () => monotonic++ });
    const tick = await worker.tick();
    const [healthResponse, dashboardResponse, telemetryResponse, invalidTelemetryResponse] = await Promise.all([
      fetch(`${telemetryOrigin}/healthz`), fetch(`${telemetryOrigin}/api/dashboard`),
      fetch(`${telemetryOrigin}/api/telemetry/worker?window=24h`),
      fetch(`${telemetryOrigin}/api/telemetry/worker?window=all`),
    ]);
    const health = await healthResponse.json();
    const dashboard = await dashboardResponse.json();
    const telemetry = await telemetryResponse.json();
    assert.equal(tick.telemetry.durationMs, 5);
    assert.equal(health.worker.lastTick.durationMs, 5);
    assert.equal(health.worker.lastTick.dependencies.marketData.status, 'SKIPPED');
    assert.equal(health.worker.lastTick.dependencies.newsCalendar.status, 'OFFLINE');
    assert.deepEqual(dashboard.worker.lastTick, health.worker.lastTick);
    assert.equal(dashboard.worker.telemetryLastHour.sampleCount, 1);
    assert.equal(dashboard.worker.telemetryLastHour.durationMs.p95, 5);
    assert.equal(telemetry.window, '24h');
    assert.equal(telemetry.sampleCount, 1);
    assert.equal(telemetry.dependencies.brokerHealth.attempts, 1);
    assert.equal(telemetry.dependencies.brokerHealth.failures, 1);
    assert.equal(invalidTelemetryResponse.status, 400);
  } finally {
    await new Promise((resolve, reject) => telemetryServer.close((error) => error ? reject(error) : resolve()));
    telemetryDb.close();
  }
});

test('worker telemetry reports retained-window percentiles and low-cardinality dependency failures', async () => {
  const now = new Date('2026-09-21T01:00:00.000Z');
  const telemetryDb = openDatabase(':memory:', fileURLToPath(new URL('../src/migrations/', import.meta.url)));
  initializeDatabase(telemetryDb, now);
  const insert = telemetryDb.prepare(`
    INSERT INTO worker_cycle_metrics (
      observed_at, duration_ms, error_class,
      broker_health_attempted, broker_health_duration_ms, broker_health_status,
      market_data_attempted, market_data_duration_ms, market_data_status,
      news_calendar_attempted, news_calendar_duration_ms, news_calendar_status
    ) VALUES (?, ?, ?, 1, ?, ?, 0, NULL, 'SKIPPED', 1, 2, ?)
  `);
  insert.run('2026-09-20T23:00:00.000Z', 500, null, 1, 'HEALTHY', 'HEALTHY');
  insert.run('2026-09-21T00:00:00.000Z', 10, null, 1, 'HEALTHY', 'HEALTHY');
  insert.run('2026-09-21T00:10:00.000Z', 20, null, 2, 'HEALTHY', 'HEALTHY');
  insert.run('2026-09-21T00:20:00.000Z', 30, 'TYPE_ERROR', 3, 'OFFLINE', 'OFFLINE');
  insert.run('2026-09-21T00:30:00.000Z', 100, null, 4, 'HEALTHY', 'HEALTHY');
  insert.run('2026-09-21T01:05:00.000Z', 900, 'UNCLASSIFIED', 5, 'ERROR', 'ERROR');
  const telemetryServer = createNexoraServer({ db: telemetryDb, clock: () => now, operatorToken: null });
  await new Promise((resolve) => telemetryServer.listen(0, '127.0.0.1', resolve));
  const telemetryOrigin = `http://127.0.0.1:${telemetryServer.address().port}`;
  try {
    const oneHourResponse = await fetch(`${telemetryOrigin}/api/telemetry/worker?window=1h`);
    const oneHour = await oneHourResponse.json();
    assert.equal(oneHourResponse.status, 200);
    assert.equal(oneHour.sampleCount, 4);
    assert.equal(oneHour.failedCycles, 1);
    assert.equal(oneHour.errorRatePct, 25);
    assert.deepEqual(oneHour.durationMs, { p50: 20, p95: 100, max: 100 });
    assert.deepEqual(oneHour.dependencies.brokerHealth, {
      attempts: 4, failures: 1, p95DurationMs: 4, statuses: { HEALTHY: 3, OFFLINE: 1 },
    });
    assert.equal(oneHour.dependencies.marketData.attempts, 0);
    assert.equal(oneHour.dependencies.marketData.p95DurationMs, null);
    assert.equal(oneHour.latestSampleAt, '2026-09-21T00:30:00.000Z');
    assert.doesNotMatch(JSON.stringify(oneHour), /TestBroker|token|secret|payload/i);

    const dayResponse = await fetch(`${telemetryOrigin}/api/telemetry/worker?window=24h`);
    const day = await dayResponse.json();
    assert.equal(day.sampleCount, 5);
    assert.equal(day.durationMs.max, 500);
  } finally {
    await new Promise((resolve, reject) => telemetryServer.close((error) => error ? reject(error) : resolve()));
    telemetryDb.close();
  }
});

test('static dashboard shell and bundle expose honest risk state and responsive breakpoints', async () => {
  const [page, script, stylesheet] = await Promise.all([
    fetch(origin), fetch(`${origin}/app.js`), fetch(`${origin}/styles.css`),
  ]);
  assert.equal(page.status, 200);
  assert.equal(script.status, 200);
  assert.equal(stylesheet.status, 200);
  const html = await page.text();
  const js = await script.text();
  const css = await stylesheet.text();
  assert.match(html, /NEXORA XAU FOREX AUTO TRADING/);
  assert.match(html, /id="paperModeState"/);
  assert.ok(js.includes('PAPER OFF · MONITORING ONLY'));
  assert.match(html, /telegramStatus/);
  assert.match(html, /riskFreshness/);
  assert.match(html, /workerLatency/);
  assert.match(html, /workerTrend/);
  assert.match(js, /position-mark-meta/);
  assert.match(html, /researchDatasetName/);
  assert.match(html, /<th>Action<\/th>/);
  assert.match(js, /risk state unavailable or stale/);
  assert.match(js, /\/api\/actions\/research/);
  assert.match(js, /\/api\/actions\/close/);
  assert.match(js, /const API_REQUEST_TIMEOUT_MS = 8_000/);
  assert.match(js, /controller\.abort\(\)/);
  assert.match(js, /if \(controller\.signal\.aborted\) throw error/);
  assert.match(js, /Local API request timed out after/);
  assert.match(js, /window\.clearTimeout\(timeoutId\)/);
  assert.match(js, /setInterval\(\(\) => void loadDashboard\(\), 15_000\)/);
  assert.match(js, /telegram\.enabled/);
  assert.match(js, /worker\?\.lastTick/);
  assert.match(js, /telemetryLastHour/);
  assert.match(js, /item\.lastMarkAt/);
  assert.ok(js.includes("risk.freshness !== 'FRESH'"));
  assert.match(css, /max-width:\s*1200px/);
  assert.match(css, /max-width:\s*820px/);
  assert.match(css, /max-width:\s*480px/);

  const requestDefinition = js.match(/async function request\(path, options = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(requestDefinition, 'the dashboard request helper should be present in its bundle');
  let timerCleared = false;
  const requestWithDeadline = runInNewContext(
    '(() => { const API_REQUEST_TIMEOUT_MS = 20; let operatorToken = ""; '
      + requestDefinition
      + '; return request; })()',
    {
      AbortController,
      Headers,
      window: {
        setTimeout,
        clearTimeout(timer) {
          timerCleared = true;
          clearTimeout(timer);
        },
      },
      fetch: (_path, { signal }) => new Promise((_resolve, reject) => {
        const rejectOnAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      }),
    },
  );
  await assert.rejects(requestWithDeadline('/api/dashboard'), (error) => {
    assert.equal(error.name, 'TimeoutError');
    assert.match(error.message, /0\.02s/);
    return true;
  });
  assert.equal(timerCleared, true);
});

test('dashboard reports unavailable values instead of invented account or market data', async () => {
  const response = await fetch(`${origin}/api/dashboard`);
  const body = await response.json();
  assert.equal(body.trading.liveTradingEnabled, false);
  assert.equal(body.trading.entriesAllowed, false);
  assert.equal(body.trading.state, 'BROKER OFFLINE');
  assert.equal(body.broker.connected, false);
  assert.equal(body.market.quote, null);
  assert.equal(body.account.balance, null);
  assert.equal(body.risk.freshness, 'UNAVAILABLE');
  assert.equal(body.risk.status, 'RISK STATE UNAVAILABLE');
  assert.equal(body.counts.closedTrades, 0);
  assert.equal(body.statistics.sampleCount, 0);
  assert.equal(body.statistics.minimumInterpretationSample, 30);
  assert.equal(body.statistics.sufficientSample, false);
  assert.equal(body.statistics.metrics, null);
  assert.equal(body.statistics.interpretation, 'NO_PERFORMANCE_CONCLUSION_SAMPLE_BELOW_30');
  assert.equal(body.statistics.forwardEvidence.closedBrokerPaperTrades, 0);
  assert.equal(body.statistics.forwardEvidence.required, 100);
  assert.equal(body.statistics.periods.today.realizedNetPnl, null);
  assert.deepEqual(body.statistics.slices.side, {});
  assert.equal(body.control.authConfigured, true);
  assert.equal(body.control.operatorAuthenticated, false);
  assert.equal(body.telegram.enabled, false);
  assert.equal(body.telegram.notificationsEnabled, false);
  assert.equal(body.telegram.pendingNotifications, 0);
  assert.equal(body.telegram.status, 'DISABLED');
  assert.equal(body.app.buildId, config.buildId);
  assert.equal(JSON.stringify(body.telegram).includes('token'), false);
});

test('positions API preserves last marks and redacts stored snapshots at the response boundary', async () => {
  const now = new Date('2026-09-21T13:00:00.000Z');
  const positionsDb = openDatabase(':memory:', fileURLToPath(new URL('../src/migrations/', import.meta.url)));
  initializeDatabase(positionsDb, now);
  const positionsServer = createNexoraServer({ db: positionsDb, clock: () => now, operatorToken: null });
  await new Promise((resolve) => positionsServer.listen(0, '127.0.0.1', resolve));
  const positionsOrigin = `http://127.0.0.1:${positionsServer.address().port}`;
  const insertOrder = positionsDb.prepare(`
    INSERT INTO orders (id, idempotency_key, symbol, side, order_type, status, quantity_lots,
      entry_price, stop_price, take_profit_1, take_profit_2, expires_at, created_at, updated_at,
      snapshot_json, remaining_quantity_lots)
    VALUES (?, ?, 'XAUUSD', 'BUY', 'LIMIT', 'FILLED', '0.1', '2000', '1990', '2010', '2020',
      '2026-09-21T14:00:00.000Z', '2026-09-21T12:00:00.000Z', '2026-09-21T12:01:00.000Z', '{}', '0')
  `);
  const insertPosition = positionsDb.prepare(`
    INSERT INTO positions (id, order_id, symbol, side, status, quantity_open_lots, quantity_initial_lots,
      entry_price, stop_price, take_profit_1, take_profit_2, opened_at, snapshot_json)
    VALUES (?, ?, 'XAUUSD', 'LONG', 'OPEN', '0.1', '0.1', '2000', '1990', '2010', '2020', ?, ?)
  `);
  const lastMarkAt = '2026-09-21T12:59:00.000Z';
  insertOrder.run('order-mark-valid', 'order-mark-valid-key');
  insertPosition.run(
    'position-mark-valid', 'order-mark-valid', '2026-09-21T12:01:00.000Z',
    JSON.stringify({
      fills: [{ quote: { observedAt: lastMarkAt } }],
      providerContext: { apiKey: 'NEXORA_TEST_ONLY_SENTINEL_DO_NOT_LEAK', nested: { refreshToken: 'SENTINEL_REFRESH_TOKEN' } },
    }),
  );
  insertOrder.run('order-mark-future', 'order-mark-future-key');
  const futureSnapshot = { lastMarketQuote: { observedAt: '2026-09-21T13:01:00.000Z' } };
  let nestedFutureSnapshot = futureSnapshot;
  for (let depth = 0; depth < 40; depth += 1) {
    nestedFutureSnapshot.next = {};
    nestedFutureSnapshot = nestedFutureSnapshot.next;
  }
  nestedFutureSnapshot.marker = 'NEXORA_DEPTH_TEST_SENTINEL';
  insertPosition.run(
    'position-mark-future', 'order-mark-future', '2026-09-21T12:02:00.000Z', JSON.stringify(futureSnapshot),
  );
  insertOrder.run('order-mark-malformed', 'order-mark-malformed-key');
  insertPosition.run(
    'position-mark-malformed', 'order-mark-malformed', '2026-09-21T12:03:00.000Z',
    'NEXORA_MALFORMED_JSON_TEST_SENTINEL {',
  );
  try {
    const response = await fetch(`${positionsOrigin}/api/positions`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.length, 3);
    const validMark = body.find((position) => position.id === 'position-mark-valid');
    const futureMark = body.find((position) => position.id === 'position-mark-future');
    const malformedMark = body.find((position) => position.id === 'position-mark-malformed');
    assert.equal(validMark.lastMarkAt, lastMarkAt);
    assert.equal(futureMark.lastMarkAt, null);
    assert.equal(malformedMark.lastMarkAt, null);
    assert.doesNotMatch(JSON.stringify(body), /NEXORA_TEST_ONLY_SENTINEL_DO_NOT_LEAK|SENTINEL_REFRESH_TOKEN|NEXORA_DEPTH_TEST_SENTINEL|NEXORA_MALFORMED_JSON_TEST_SENTINEL/);
    assert.match(validMark.snapshot_json, /\[REDACTED\]/);
    assert.match(futureMark.snapshot_json, /\[DEPTH_LIMIT\]/);
    assert.equal(malformedMark.snapshot_json, '[UNREADABLE]');
  } finally {
    await new Promise((resolve, reject) => positionsServer.close((error) => error ? reject(error) : resolve()));
    positionsDb.close();
  }
});

test('operator token gates mutations and is never returned by the dashboard', async () => {
  const anonymous = await fetch(`${origin}/api/actions/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'auth-anonymous-0001', origin },
    body: '{}',
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error, 'CONTROL_AUTH_REQUIRED');

  const wrong = await fetch(`${origin}/api/actions/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'auth-wrong-0001', origin, authorization: 'Bearer wrong-token' },
    body: '{}',
  });
  assert.equal(wrong.status, 401);

  const authorizedDashboard = await fetch(`${origin}/api/dashboard`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
  const body = await authorizedDashboard.json();
  assert.equal(body.control.operatorAuthenticated, true);
  assert.equal(JSON.stringify(body).includes(CONTROL_TOKEN), false);
});

test('mutations fail closed when no operator token is configured', async () => {
  const readOnlyServer = createNexoraServer({ db, clock: () => new Date('2026-09-21T00:00:00.000Z'), operatorToken: null });
  await new Promise((resolve) => readOnlyServer.listen(0, '127.0.0.1', resolve));
  const readOnlyOrigin = `http://127.0.0.1:${readOnlyServer.address().port}`;
  try {
    const health = await fetch(`${readOnlyOrigin}/healthz`);
    assert.equal((await health.json()).controlActionsAvailable, false);
    const response = await fetch(`${readOnlyOrigin}/api/actions/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'auth-unconfigured-0001', origin: readOnlyOrigin },
      body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'CONTROL_AUTH_NOT_CONFIGURED');
  } finally {
    await new Promise((resolve, reject) => readOnlyServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('historical research API is authenticated, validated, idempotent, and never promotes its report to a profit claim', async () => {
  const calls = [];
  const testReport = {
    runId: 'a'.repeat(64),
    reportSha256: 'b'.repeat(64),
    evidenceClass: 'OWNER_ATTESTED_HISTORICAL_REPLAY',
    performanceEvidenceEligible: false,
    profitabilityClaim: false,
    liveTradingEnabled: false,
    strategyVersion: 'mtf-paper-fixture-v1',
    provenance: {
      datasetId: 'test-history-v1', dataClass: 'BROKER_HISTORICAL',
      sourceAttestation: 'OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED', datasetSha256: 'c'.repeat(64),
      provider: 'TestVendor', quoteCount: 150, quoteCoverage: { maximumObservedGapMs: 900_000, gapsOver30Seconds: 2 },
      candleCounts: { H4: 110, H1: 110, M30: 120, M15: 150 },
    },
    foldOptions: { foldCount: 1, trainingFraction: 0.7, minimumTrainingBars: 100 },
    methodology: { limitations: ['Provider history is owner asserted.'] },
    folds: [{
      fold: 1, testStartAt: '2025-01-01T00:00:00.000Z', testEndAt: '2025-01-02T00:00:00.000Z',
      testBars: 45, scans: 45, scanCoveragePct: 100, closedTradeCount: 0,
      performance: { sampleCount: 0, metrics: null, suppressedReason: 'SAMPLE_BELOW_30' },
      remaining: { openPositions: 0, pendingOrders: 0, expiredOrders: 0 },
    }],
  };
  const researchServer = createNexoraServer({
    db,
    clock: () => new Date('2026-09-21T00:00:00.000Z'),
    operatorToken: CONTROL_TOKEN,
    researchRunner: async (request) => { calls.push(request); return testReport; },
  });
  await new Promise((resolve) => researchServer.listen(0, '127.0.0.1', resolve));
  const researchOrigin = `http://127.0.0.1:${researchServer.address().port}`;
  const requestHeaders = {
    'content-type': 'application/json', origin: researchOrigin, authorization: `Bearer ${CONTROL_TOKEN}`,
  };
  try {
    const anonymous = await fetch(`${researchOrigin}/api/actions/research`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: researchOrigin }, body: JSON.stringify({ datasetName: 'xau-history.json' }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(calls.length, 0);

    const invalid = await fetch(`${researchOrigin}/api/actions/research`, {
      method: 'POST', headers: { ...requestHeaders, 'idempotency-key': 'research-invalid-0001' },
      body: JSON.stringify({ datasetName: '../outside.json' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);

    const headers = { ...requestHeaders, 'idempotency-key': 'research-run-0000001' };
    const first = await fetch(`${researchOrigin}/api/actions/research`, {
      method: 'POST', headers, body: JSON.stringify({ datasetName: 'xau-history.json', options: { foldCount: 1 } }),
    });
    const result = await first.json();
    assert.equal(first.status, 200);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.liveTradingEnabled, false);
    assert.equal(result.profitabilityClaim, false);
    assert.equal(result.folds[0].performance.metrics, null);
    assert.equal(result.folds[0].performance.suppressedReason, 'SAMPLE_BELOW_30');
    assert.equal(result.idempotentReplay, false);
    assert.equal(calls.length, 1);

    const replay = await fetch(`${researchOrigin}/api/actions/research`, {
      method: 'POST', headers, body: JSON.stringify({ datasetName: 'xau-history.json', options: { foldCount: 1 } }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotentReplay, true);
    assert.equal(calls.length, 1);

    const changedRequest = await fetch(`${researchOrigin}/api/actions/research`, {
      method: 'POST', headers, body: JSON.stringify({ datasetName: 'other-history.json', options: { foldCount: 1 } }),
    });
    assert.equal(changedRequest.status, 409);
    assert.equal((await changedRequest.json()).error, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    assert.equal(calls.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'HISTORICAL_RESEARCH_COMPLETED'").get().n, 1);
  } finally {
    await new Promise((resolve, reject) => researchServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('paper mode can be turned off safely and back on only while entries remain paused', async () => {
  const headers = { 'content-type': 'application/json', origin, authorization: `Bearer ${CONTROL_TOKEN}` };
  const disabled = await fetch(`${origin}/api/actions/paper`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'paper-disable-0001' }, body: JSON.stringify({ enabled: false }),
  });
  const disabledBody = await disabled.json();
  assert.equal(disabled.status, 200);
  assert.equal(disabledBody.mode, 'MONITORING_ONLY');
  assert.equal(readState(db, 'paperMode'), false);
  assert.equal(readState(db, 'entryPaused'), true);

  const replay = await fetch(`${origin}/api/actions/paper`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'paper-disable-0001' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await replay.json()).idempotentReplay, true);
  assert.equal(readState(db, 'paperMode'), false);

  const invalid = await fetch(`${origin}/api/actions/paper`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'paper-invalid-0001' }, body: JSON.stringify({ enabled: 'false' }),
  });
  assert.equal(invalid.status, 400);

  const enabled = await fetch(`${origin}/api/actions/paper`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'paper-enable-0001' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal(readState(db, 'paperMode'), true);
  assert.equal(readState(db, 'entryPaused'), true);
});

test('stats endpoint returns persisted journal rollups without fabricating results', async () => {
  const response = await fetch(`${origin}/api/stats`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.sampleCount, 0);
  assert.equal(body.minimumInterpretationSample, 30);
  assert.equal(body.metrics, null);
  assert.equal(body.pendingExpiredCount, 0);
  assert.equal(body.forwardEvidence.closedBrokerPaperTrades, 0);
});

test('pause action is persisted and idempotent', async () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'pause-test-0001', origin, authorization: `Bearer ${CONTROL_TOKEN}` };
  const first = await fetch(`${origin}/api/actions/pause`, { method: 'POST', headers, body: '{}' });
  const second = await fetch(`${origin}/api/actions/pause`, { method: 'POST', headers, body: '{}' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).idempotentReplay, true);
  assert.equal(readState(db, 'entryPaused'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'ENTRY_PAUSED'").get().n, 1);
  assert.notEqual(first.headers.get('x-request-id'), second.headers.get('x-request-id'));
  const audit = db.prepare("SELECT metadata_json FROM audit_events WHERE event_type = 'ENTRY_PAUSED' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.metadata_json).httpRequestId, first.headers.get('x-request-id'));
});

test('manual paper close route is authenticated, idempotent per position, and requires a fresh broker quote', async () => {
  const headers = {
    'content-type': 'application/json', 'idempotency-key': 'manual-close-test-0001', origin,
    authorization: `Bearer ${CONTROL_TOKEN}`,
  };
  const path = `${origin}/api/actions/close`;
  const first = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ positionId: 'position-test-0001' }) });
  const firstBody = await first.json();
  assert.equal(first.status, 409);
  assert.equal(firstBody.error, 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED');
  assert.equal(firstBody.liveTradingEnabled, false);

  const replay = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ positionId: 'position-test-0001' }) });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).idempotentReplay, true);
  const audit = db.prepare(`
    SELECT metadata_json FROM audit_events
    WHERE event_type = 'PAPER_POSITION_MANUAL_CLOSE_REJECTED' AND entity_id = ? ORDER BY rowid LIMIT 1
  `).get('position-test-0001');
  assert.equal(JSON.parse(audit.metadata_json).httpRequestId, first.headers.get('x-request-id'));

  const differentPosition = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ positionId: 'position-test-0002' }) });
  assert.equal(differentPosition.status, 409);
  assert.equal((await differentPosition.json()).idempotentReplay, false);

  const invalid = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ positionId: '../position' }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'PAPER_POSITION_ID_INVALID');
});

test('Telegram control dispatch uses authenticated local actions and preserves resume readiness gates', async () => {
  const auditBefore = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'ENTRY_PAUSED'").get().n;
  const context = {
    db, operatorToken: CONTROL_TOKEN, baseUrl: origin, updateId: 81234,
    command: { name: 'pause', args: [] },
  };
  const first = await handleTelegramCommand(context);
  const replay = await handleTelegramCommand(context);
  assert.match(first, /dijeda/);
  assert.equal(replay, first);
  assert.equal(readState(db, 'entryPaused'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'ENTRY_PAUSED'").get().n, auditBefore + 1);

  const resume = await handleTelegramCommand({
    ...context, updateId: 81235, command: { name: 'resume', args: [] },
  });
  assert.match(resume, /Resume ditolak/);
  assert.equal(readState(db, 'entryPaused'), true);
});

test('resume is fail-closed while broker data is unavailable', async () => {
  const response = await fetch(`${origin}/api/actions/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resume-test-0001', origin, authorization: `Bearer ${CONTROL_TOKEN}` },
    body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'READINESS_NOT_MET');
  assert.ok(body.readinessReasons.includes('BROKER_OFFLINE'));
  assert.ok(body.readinessReasons.includes('MARKET_DATA_NOT_FRESH'));
  assert.ok(body.readinessReasons.includes('NEWS_NOT_READY'));
  assert.equal(readState(db, 'entryPaused'), true);
});

test('resume still requires fresh market and news data when broker health is green', async () => {
  db.prepare(`INSERT INTO broker_health (source, status, checked_at, details_json) VALUES (?, 'HEALTHY', ?, ?)`)
    .run('test-provider', '2026-09-21T00:00:00.000Z', JSON.stringify({ reason: null }));
  writeState(db, 'worker', { running: true, heartbeatAt: '2026-09-21T00:00:00.000Z' }, '2026-09-21T00:00:00.000Z');

  const response = await fetch(`${origin}/api/actions/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resume-test-0002', origin, authorization: `Bearer ${CONTROL_TOKEN}` },
    body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'READINESS_NOT_MET');
  assert.deepEqual(body.readinessReasons, ['MARKET_DATA_NOT_FRESH', 'MARKET_CANDLES_NOT_FRESH', 'NEWS_NOT_READY', 'RISK_STATE_NOT_FRESH']);
  assert.equal(readState(db, 'entryPaused'), true);

  db.prepare('DELETE FROM broker_health').run();
  writeState(db, 'worker', { running: false, heartbeatAt: null }, '2026-09-21T00:00:00.000Z');
});

test('resume remains blocked while paper execution mode is off', async () => {
  writeState(db, 'paperMode', false, '2026-09-21T00:00:00.000Z');
  const response = await fetch(`${origin}/api/actions/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'resume-paper-off-01', origin, authorization: `Bearer ${CONTROL_TOKEN}` },
    body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.ok(body.readinessReasons.includes('PAPER_MODE_DISABLED'));
  assert.equal(readState(db, 'entryPaused'), true);
  writeState(db, 'paperMode', true, '2026-09-21T00:00:00.000Z');
});

test('scan logs a blocked decision and never creates an order without verified feed data', async () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'scan-test-0001', origin, authorization: `Bearer ${CONTROL_TOKEN}` };
  const [first, replay] = await Promise.all([
    fetch(`${origin}/api/actions/scan`, { method: 'POST', headers, body: '{}' }),
    fetch(`${origin}/api/actions/scan`, { method: 'POST', headers, body: '{}' }),
  ]);
  assert.equal(first.status, 409);
  assert.equal(replay.status, 409);
  assert.ok((await first.json()).reasons.includes('BROKER_OFFLINE'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM timeframe_analyses').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_decisions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  const storedScan = db.prepare('SELECT config_version, correlation_id FROM scan_runs LIMIT 1').get();
  const scanAudit = db.prepare(`
    SELECT metadata_json FROM audit_events WHERE event_type = 'PAPER_SCAN_REJECTED' AND correlation_id = ?
  `).get(storedScan.correlation_id);
  assert.ok([first.headers.get('x-request-id'), replay.headers.get('x-request-id')]
    .includes(JSON.parse(scanAudit.metadata_json).httpRequestId));
  const storedConfig = db.prepare('SELECT config_json FROM config_versions WHERE version = ?').get(storedScan.config_version);
  assert.ok(storedConfig);
  const configManifest = JSON.parse(storedConfig.config_json);
  assert.equal(configManifest.strategyParameters.minimumCandlesPerTimeframe, 100);
  assert.equal(configManifest.minSignalScore, 70);
  assert.ok(configManifest.parameterRationale.strategy.timeframeWeights.H4);
  assert.ok(configManifest.parameterRationale.risk.maxSpreadPrice);
  assert.equal(configManifest.version, storedScan.config_version);
  assert.equal(fingerprintConfiguration(configManifest.versionManifest, configManifest.profileId), storedScan.config_version);
  const originalRiskRow = db.prepare("SELECT value_json, updated_at FROM app_state WHERE key = 'riskMetrics'").get();
  try {
    writeState(db, 'riskMetrics', {
      equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0, maxSpreadPrice: 0.5,
    }, '2026-09-21T00:00:00.000Z');

    const nextRequest = await fetch(`${origin}/api/actions/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'scan-test-0002', origin, authorization: `Bearer ${CONTROL_TOKEN}` },
      body: '{}',
    });
    const repeatedLogicalScan = await nextRequest.json();
    assert.equal(nextRequest.status, 409);
    assert.equal(repeatedLogicalScan.logicalReplay, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
    assert.equal(db.prepare('SELECT config_version FROM scan_runs LIMIT 1').get().config_version, storedScan.config_version);
  } finally {
    if (originalRiskRow) {
      db.prepare("UPDATE app_state SET value_json = ?, updated_at = ? WHERE key = 'riskMetrics'")
        .run(originalRiskRow.value_json, originalRiskRow.updated_at);
    } else {
      db.prepare("DELETE FROM app_state WHERE key = 'riskMetrics'").run();
    }
  }
});

test('market candle API returns only verified closed broker data and computes actual indicators', async () => {
  const insert = db.prepare(`
    INSERT INTO candles (symbol, timeframe, closed_at, open_price, high_price, low_price, close_price, tick_volume, source, quality)
    VALUES ('XAUUSD', 'M15', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.parse('2026-09-21T00:00:00.000Z');
  for (let index = 0; index < 100; index += 1) {
    const close = 1900 + index * 0.1;
    const open = close - 0.03;
    const closedAt = new Date(now - (99 - index) * 15 * 60_000).toISOString();
    insert.run(closedAt, String(open), String(close + 0.05), String(open - 0.05), String(close), 100 + index, 'BROKER', 'VERIFIED_CLOSED');
  }
  insert.run('2026-09-21T00:00:01.000Z', '2000', '2001', '1999', '2000.5', 500, 'SYNTHETIC', 'FIXTURE');

  const response = await fetch(`${origin}/api/market/candles?timeframe=M15`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'BROKER');
  assert.equal(body.dataFreshness, 'FRESH');
  assert.equal(body.candleCount, 100);
  assert.equal(body.sufficientHistory, true);
  assert.equal(body.candles.at(-1).closedAt, new Date(now).toISOString());
  assert.ok(body.indicators.ema9 > 0);
  assert.ok(body.indicators.atr14 > 0);
  assert.equal(body.ema9Series.length, 100);

  const unsupported = await fetch(`${origin}/api/market/candles?timeframe=D1`);
  assert.equal(unsupported.status, 400);
});

test('latest MTF API exposes persisted deterministic decision and timeframe evidence', async () => {
  const response = await fetch(`${origin}/api/mtf/latest`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'WAITING');
  assert.ok(body.scan.id);
  assert.equal(body.analyses.length, 4);
  assert.ok(Array.isArray(body.analyses[0].rejectionReasons));
  assert.equal(body.decision.direction, 'NEUTRAL');
  assert.equal(typeof body.decision.snapshot.gate.score, 'number');
});

test('FX session window uses DST-aware IANA zones and discloses weekend schedule', () => {
  const beforeLondonDst = activeSessions(new Date('2026-03-27T07:30:00.000Z'));
  const afterLondonDst = activeSessions(new Date('2026-03-30T07:30:00.000Z'));
  const saturday = activeSessions(new Date('2026-09-26T12:00:00.000Z'));
  assert.equal(beforeLondonDst.active.includes('LONDON'), false);
  assert.equal(afterLondonDst.active.includes('LONDON'), true);
  assert.equal(saturday.marketScheduleStatus, 'WEEKEND_CLOSED');
  assert.deepEqual(saturday.active, []);
});

test('cross-origin mutations and non-loopback hosts are rejected', async () => {
  const crossOrigin = await fetch(`${origin}/api/actions/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'csrf-test-0001', origin: 'https://attacker.invalid' },
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);

  assert.equal(validLocalHost('example.invalid'), false);
  assert.equal(validLocalHost(`127.0.0.1:${server.address().port}`), true);
});

test('audit events reject updates and deletes', () => {
  const id = appendAudit(db, { eventType: 'TEST_APPEND_ONLY', reason: 'test' }, '2026-09-21T00:00:00.000Z');
  assert.throws(() => db.prepare('UPDATE audit_events SET reason = ? WHERE id = ?').run('changed', id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(id), /append-only/);
});

test('versioned configuration manifests reject updates and deletes', () => {
  const row = db.prepare('SELECT version FROM config_versions LIMIT 1').get();
  assert.ok(row);
  assert.throws(() => db.prepare('UPDATE config_versions SET rationale = ? WHERE version = ?').run('changed', row.version), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM config_versions WHERE version = ?').run(row.version), /append-only/);
  assert.ok(db.prepare('SELECT version FROM config_versions WHERE version = ?').get(row.version));
});

test('SQLite state survives closing and reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexora-recovery-'));
  const file = join(directory, 'state.sqlite');
  const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
  const firstDb = openDatabase(file, migrations);
  initializeDatabase(firstDb, new Date('2026-09-21T00:00:00.000Z'));
  writeState(firstDb, 'entryPaused', false, '2026-09-21T00:05:00.000Z');
  writeState(firstDb, 'paperMode', false, '2026-09-21T00:05:00.000Z');
  firstDb.close();

  const recoveredDb = openDatabase(file, migrations);
  assert.equal(readState(recoveredDb, 'entryPaused'), false);
  initializeDatabase(recoveredDb, new Date('2026-09-21T00:10:00.000Z'));
  assert.equal(readState(recoveredDb, 'entryPaused'), true);
  assert.equal(readState(recoveredDb, 'paperMode'), false);
  assert.equal(recoveredDb.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 8);
  recoveredDb.close();
  rmSync(directory, { recursive: true, force: true });
});
