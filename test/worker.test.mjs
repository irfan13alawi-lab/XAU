import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, readState } from '../src/database.mjs';
import { initializeDatabase } from '../src/server.mjs';
import { loadFreshRiskMetrics } from '../src/services/risk-state-service.mjs';
import { PaperWorker, UnavailableMarketDataProvider, pruneWorkerCycleTelemetry } from '../src/worker.mjs';

const timeframes = { M15: 15 * 60_000, M30: 30 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000 };

function dbFixture(now) {
  const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
  const db = openDatabase(':memory:', migrations);
  initializeDatabase(db, now);
  return db;
}

function closedCandles(now) {
  return Object.fromEntries(Object.entries(timeframes).map(([timeframe, interval]) => {
    const count = 110;
    const latestClose = now.getTime() - interval;
    const firstClose = latestClose - (count - 1) * interval;
    const candles = Array.from({ length: count }, (_, index) => {
      const open = 1900 + index * 0.2;
      const close = open + 0.1;
      return {
        open, close, high: close + 0.15, low: open - 0.15,
        tickVolume: 100 + index, closedAt: new Date(firstClose + index * interval).toISOString(), source: 'BROKER',
      };
    });
    return [timeframe, candles];
  }));
}

function providers(now) {
  return {
    provider: {
      async readHealth() { return { source: 'TestBrokerAdapter', status: 'HEALTHY' }; },
      async readMarketData() {
        const at = now.toISOString();
        return {
          source: 'BROKER',
          quote: { symbol: 'XAUUSD', source: 'BROKER', bid: 2010.0, ask: 2010.2, last: 2010.1, observedAt: at },
          candlesByTimeframe: closedCandles(now),
          riskMetrics: {
            equity: 10_000, currency: 'USD', dailyLossR: 0, drawdownPct: 0,
            maxSpreadPrice: 1, observedAt: at,
          },
        };
      },
    },
    newsProvider: {
      async readCalendar() {
        return {
          source: 'TestCalendar', status: 'HEALTHY', fetchedAt: now.toISOString(),
          events: [{ eventKey: 'usd-cpi-0001', title: 'CPI test fixture', category: 'CPI', currency: 'USD', impact: 'HIGH', scheduledAt: new Date(now.getTime() + 10 * 60_000).toISOString() }],
        };
      },
    },
  };
}

test('default worker remains offline and never manufactures quote or candles', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    let monotonic = 0;
    const worker = new PaperWorker({
      db, provider: new UnavailableMarketDataProvider(), clock: () => now,
      monotonicNow: () => monotonic++,
    });
    const result = await worker.tick();
    assert.equal(result.health.status, 'OFFLINE');
    assert.equal(result.telemetry.durationMs, 5);
    assert.deepEqual(result.telemetry.dependencies.brokerHealth, { attempted: true, durationMs: 1, status: 'OFFLINE' });
    assert.deepEqual(result.telemetry.dependencies.marketData, { attempted: false, durationMs: null, status: 'SKIPPED' });
    assert.deepEqual(result.telemetry.dependencies.newsCalendar, { attempted: true, durationMs: 1, status: 'OFFLINE' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candles').get().n, 0);
    assert.equal(readState(db, 'marketDataHealth', {}).status, undefined);
    assert.equal(readState(db, 'newsProvider').status, 'OFFLINE');
    assert.equal(readState(db, 'worker').running, true);
    assert.deepEqual(readState(db, 'worker').lastTick, result.telemetry);
    const metric = db.prepare(`
      SELECT observed_at, duration_ms, error_class, broker_health_status, market_data_status, news_calendar_status
      FROM worker_cycle_metrics ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual({ ...metric }, {
      observed_at: now.toISOString(), duration_ms: 5, error_class: null,
      broker_health_status: 'OFFLINE', market_data_status: 'SKIPPED', news_calendar_status: 'OFFLINE',
    });
  } finally {
    db.close();
  }
});

test('worker telemetry persists classified failures without storing exception payloads', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    let injectFailure = true;
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql) => {
          if (injectFailure && /INSERT INTO broker_health/.test(sql)) {
            injectFailure = false;
            const error = new Error('private-provider-message-sentinel');
            error.code = 'SQLITE_IOERR';
            throw error;
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const worker = new PaperWorker({
      db: failingDb,
      clock: () => now,
      provider: {
        async readHealth() { return { source: 'TestBroker', status: 'HEALTHY' }; },
      },
    });
    const result = await worker.tick();
    assert.equal(result.error, 'WORKER_TICK_FAILED');
    assert.equal(result.errorClass, 'SQLITE_IOERR');
    const metric = db.prepare(`
      SELECT error_class, broker_health_status, market_data_status, news_calendar_status
      FROM worker_cycle_metrics ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual({ ...metric }, {
      error_class: 'SQLITE_IOERR', broker_health_status: 'HEALTHY',
      market_data_status: 'SKIPPED', news_calendar_status: 'NOT_ATTEMPTED',
    });
    assert.doesNotMatch(JSON.stringify(metric), /private-provider-message-sentinel/);
    assert.equal(readState(db, 'entryPaused'), true);
  } finally {
    db.close();
  }
});

test('worker telemetry retention enforces seven days and a hard sample cap', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    const insert = db.prepare(`
      INSERT INTO worker_cycle_metrics (
        observed_at, duration_ms, error_class,
        broker_health_attempted, broker_health_duration_ms, broker_health_status,
        market_data_attempted, market_data_duration_ms, market_data_status,
        news_calendar_attempted, news_calendar_duration_ms, news_calendar_status
      ) VALUES (?, 1, NULL, 1, 1, 'HEALTHY', 0, NULL, 'SKIPPED', 0, NULL, 'NOT_ATTEMPTED')
    `);
    insert.run('2026-09-14T11:59:59.999Z');
    insert.run('2026-09-14T12:00:00.000Z');
    insert.run(now.toISOString());
    pruneWorkerCycleTelemetry(db, now);
    assert.deepEqual(db.prepare('SELECT observed_at FROM worker_cycle_metrics ORDER BY observed_at').all().map((row) => row.observed_at), [
      '2026-09-14T12:00:00.000Z', now.toISOString(),
    ]);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 60_001; index += 1) insert.run(now.toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    pruneWorkerCycleTelemetry(db, now);
    const retained = db.prepare('SELECT COUNT(*) AS count, MIN(id) AS firstId, MAX(id) AS lastId FROM worker_cycle_metrics').get();
    assert.equal(retained.count, 59_936);
    assert.equal(retained.lastId - retained.firstId, 59_935);
  } finally {
    db.close();
  }
});

test('worker ingests normalized data, applies news blackout, and scans a new closed M15 candle once', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    const fakeProviders = providers(now);
    const worker = new PaperWorker({ db, ...fakeProviders, clock: () => now });
    const first = await worker.tick();
    assert.equal(first.health.status, 'HEALTHY');
    assert.equal(first.market.status, 'HEALTHY');
    assert.equal(first.news.status, 'HEALTHY');
    assert.ok(Number.isFinite(first.telemetry.durationMs));
    assert.deepEqual(first.telemetry.dependencies.brokerHealth.status, 'HEALTHY');
    assert.deepEqual(first.telemetry.dependencies.marketData.status, 'HEALTHY');
    assert.deepEqual(first.telemetry.dependencies.newsCalendar.status, 'HEALTHY');
    assert.equal(first.telemetry.dependencies.newsCalendar.attempted, true);
    assert.ok(first.scan);
    assert.ok(first.scan.reasons.includes('NEWS_BLACKOUT'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candles').get().n, 440);
    assert.equal(loadFreshRiskMetrics(db, now).freshness, 'FRESH');
    assert.equal(loadFreshRiskMetrics(db, now).openRiskPct, 0);
    assert.equal(readState(db, 'riskMetrics').equity, 10_000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
    assert.equal(readState(db, 'lastWorkerM15Close'), '2026-09-21T11:45:00.000Z');

    const second = await worker.tick();
    assert.equal(second.scan, null);
    assert.equal(second.telemetry.dependencies.newsCalendar.attempted, false);
    assert.equal(second.telemetry.dependencies.newsCalendar.durationMs, null);
    assert.equal(second.telemetry.dependencies.newsCalendar.status, 'CACHED');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
  } finally {
    db.close();
  }
});

test('worker keeps stale risk timestamps stale and rejects null provider risk metrics', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    const staleProviders = providers(now);
    const originalReadMarketData = staleProviders.provider.readMarketData;
    staleProviders.provider.readMarketData = async () => {
      const payload = await originalReadMarketData();
      payload.riskMetrics.observedAt = new Date(now.getTime() - 31_000).toISOString();
      return payload;
    };
    await new PaperWorker({ db, ...staleProviders, clock: () => now }).tick();
    assert.equal(loadFreshRiskMetrics(db, now).freshness, 'STALE');

    const invalidProviders = providers(now);
    const invalidReadMarketData = invalidProviders.provider.readMarketData;
    invalidProviders.provider.readMarketData = async () => {
      const payload = await invalidReadMarketData();
      payload.riskMetrics.dailyLossR = null;
      return payload;
    };
    await new PaperWorker({ db, ...invalidProviders, clock: () => now }).tick();
    const riskState = loadFreshRiskMetrics(db, now);
    assert.equal(riskState.freshness, 'INVALID');
    assert.equal(riskState.reason, 'RISK_STATE_INVALID');
  } finally {
    db.close();
  }
});

test('worker applies dependency deadlines and prevents overlapping ticks', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    const timedOut = new PaperWorker({
      db,
      provider: { async readHealth() { return new Promise(() => {}); } },
      clock: () => now,
      dependencyTimeoutMs: 10,
    });
    const timedOutResult = await timedOut.tick();
    assert.equal(timedOutResult.health.status, 'OFFLINE');
    assert.equal(timedOutResult.health.reason, 'PROVIDER_HEALTH_TIMEOUT');

    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const delayed = new PaperWorker({
      db,
      provider: { readHealth() { started(); return new Promise((resolve) => { release = resolve; }); } },
      clock: () => now,
      dependencyTimeoutMs: 1000,
    });
    const firstTick = delayed.tick();
    await startedPromise;
    const overlapping = await delayed.tick();
    assert.equal(overlapping.skipped, true);
    release({ source: 'none', status: 'OFFLINE', reason: 'test' });
    await firstTick;
  } finally {
    db.close();
  }
});

test('news-provider outage holds entry readiness, preserves the last timestamp, and backs off retries', async () => {
  let now = new Date('2026-09-21T12:00:00.000Z');
  let newsCalls = 0;
  let failNews = false;
  const db = dbFixture(now);
  try {
    const worker = new PaperWorker({
      db,
      provider: new UnavailableMarketDataProvider(),
      newsProvider: {
        async readCalendar() {
          newsCalls += 1;
          if (failNews) throw new Error('token=DO_NOT_EXPOSE_NEWS_SECRET');
          return { source: 'TestCalendar', status: 'HEALTHY', fetchedAt: now.toISOString(), events: [] };
        },
      },
      clock: () => now,
      newsRefreshMs: 60_000,
    });

    const healthy = await worker.tick();
    assert.equal(healthy.news.status, 'HEALTHY');
    const lastKnownFetchedAt = healthy.news.fetchedAt;

    failNews = true;
    now = new Date(now.getTime() + 60_000);
    const outage = await worker.tick();
    assert.equal(outage.news.status, 'HEALTHY');
    assert.equal(outage.news.reason, null);
    assert.equal(outage.news.fetchedAt, lastKnownFetchedAt);
    assert.equal(outage.telemetry.dependencies.newsCalendar.status, 'HEALTHY');
    assert.equal(outage.telemetry.dependencies.newsCalendar.attempted, true);
    assert.equal(JSON.stringify(outage).includes('DO_NOT_EXPOSE_NEWS_SECRET'), false);
    assert.equal(readState(db, 'newsProvider').status, 'HEALTHY');

    now = new Date(now.getTime() + 15_000);
    const backedOff = await worker.tick();
    assert.equal(backedOff.news.status, 'HEALTHY');
    assert.equal(backedOff.telemetry.dependencies.newsCalendar.status, 'CACHED');
    assert.equal(backedOff.telemetry.dependencies.newsCalendar.attempted, false);
    assert.equal(backedOff.telemetry.dependencies.newsCalendar.durationMs, null);
    assert.equal(newsCalls, 2);

    now = new Date(now.getTime() + 31 * 60_000);
    const stale = await worker.tick();
    assert.equal(stale.news.status, 'OFFLINE');
    assert.equal(stale.news.reason, 'NEWS_PROVIDER_UNAVAILABLE');
    assert.equal(readState(db, 'newsProvider').status, 'OFFLINE');
    assert.equal(newsCalls, 3);
  } finally {
    db.close();
  }
});

test('worker market-data timeout and malformed/provider exceptions fail closed with redacted reasons', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  try {
    const timedOutMarket = new PaperWorker({
      db,
      provider: {
        async readHealth() { return { source: 'TestBroker', status: 'HEALTHY' }; },
        async readMarketData() { return new Promise(() => {}); },
      },
      clock: () => now,
      dependencyTimeoutMs: 10,
    });
    const timeoutResult = await timedOutMarket.tick();
    assert.equal(timeoutResult.telemetry.dependencies.marketData.status, 'TIMEOUT');
    assert.ok(Number.isFinite(timeoutResult.telemetry.dependencies.marketData.durationMs));
    assert.equal(readState(db, 'marketDataHealth').reason, 'MARKET_DATA_TIMEOUT');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n, 0);

    const malformed = new PaperWorker({
      db,
      provider: {
        async readHealth() { return { source: 'TestBroker', status: 'HEALTHY' }; },
        async readMarketData() { return { source: 'BROKER', quote: { symbol: 'XAUUSD', source: 'BROKER', bid: -1, ask: 2, observedAt: now.toISOString() } }; },
      },
      clock: () => now,
    });
    const malformedResult = await malformed.tick();
    assert.equal(malformedResult.telemetry.dependencies.marketData.status, 'ERROR');
    assert.equal(readState(db, 'marketDataHealth').reason, 'MARKET_DATA_INVALID_OR_UNAVAILABLE');

    const rejected = new PaperWorker({
      db,
      provider: {
        async readHealth() { return { source: 'TestBroker', status: 'HEALTHY' }; },
        async readMarketData() { throw new Error('authorization=DO_NOT_LOG_THIS_PROVIDER_SECRET'); },
      },
      clock: () => now,
    });
    const result = await rejected.tick();
    assert.equal(result.telemetry.dependencies.marketData.status, 'ERROR');
    assert.equal(JSON.stringify(result).includes('DO_NOT_LOG_THIS_PROVIDER_SECRET'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM market_snapshots').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE reason LIKE '%DO_NOT_LOG_THIS_PROVIDER_SECRET%'").get().n, 0);
  } finally {
    db.close();
  }
});

test('worker contains database-unavailable errors without leaking raw exception text or rejecting the tick promise', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  db.close();
  const worker = new PaperWorker({ db, clock: () => now });
  const result = await worker.tick();
  assert.equal(result.error, 'WORKER_TICK_FAILED');
  assert.equal(result.persistenceFailure, true);
  assert.equal('reason' in result, false);
});

test('provider labels and health/news reasons are sanitized before persistence or API results', async () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const db = dbFixture(now);
  const secret = 'DO_NOT_LOG_PROVIDER_SECRET';
  try {
    const worker = new PaperWorker({
      db,
      provider: {
        async readHealth() {
          return { source: `https://broker.invalid/?token=${secret}`, status: 'OFFLINE', reason: `authorization=${secret}` };
        },
      },
      newsProvider: {
        async readCalendar() {
          return {
            source: `calendar-${secret}`, status: 'OFFLINE', fetchedAt: null, events: [],
            reason: `calendar error ${secret}`,
          };
        },
      },
      clock: () => now,
    });
    const result = await worker.tick();
    const stored = JSON.stringify({
      result,
      health: db.prepare('SELECT * FROM broker_health').all(),
      audit: db.prepare('SELECT * FROM audit_events').all(),
      news: readState(db, 'newsProvider'),
    });
    const leakAt = stored.indexOf(secret);
    assert.equal(leakAt, -1, leakAt >= 0 ? stored.slice(Math.max(0, leakAt - 80), leakAt + secret.length + 80) : undefined);
    assert.equal(result.health.source, 'unknown');
    assert.equal(result.health.reason, 'PROVIDER_HEALTH_UNAVAILABLE');
    assert.equal(result.news.source, 'unknown');
    assert.equal(readState(db, 'newsProvider').source, 'unknown');
    assert.equal(readState(db, 'newsProvider').reason, 'NEWS_SOURCE_UNAVAILABLE');
    assert.equal(db.prepare('SELECT source FROM broker_health').get().source, 'unknown');
  } finally {
    db.close();
  }
});
