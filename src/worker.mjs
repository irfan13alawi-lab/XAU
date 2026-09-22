import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendAudit, readState, writeState } from './database.mjs';
import { executePaperScan } from './services/paper-scan-service.mjs';
import { reconcilePaperExecution } from './services/paper-lifecycle-service.mjs';
import { isAcceptedMarketSource, isFreshMarketSnapshot } from './market-source.mjs';

const TIMEFRAMES = new Set(['M15', 'M30', 'H1', 'H4']);
const TIMEOUT_MS = 5_000;
const NEWS_REFRESH_MS = 60_000;
const MAX_CANDLES_PER_FRAME = 300;
const TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_TELEMETRY_ROWS = 60_000;
const TELEMETRY_STATUSES = new Set([
  'HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED',
]);
const TELEMETRY_ERROR_CLASSES = new Set([
  'DEPENDENCY_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_IOERR',
  'BROKER_REJECTED', 'RATE_LIMITED', 'TYPE_ERROR', 'UNCLASSIFIED',
]);

function elapsedMilliseconds(start, end) {
  const elapsed = Number(end) - Number(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Number(elapsed.toFixed(1)) : null;
}

function telemetryDuration(value) {
  const duration = Number(value);
  return value !== null && value !== undefined && value !== ''
    && Number.isFinite(duration) && duration >= 0 && duration <= 600_000
    ? Number(duration.toFixed(1)) : null;
}

function telemetryDependency(dependencies, name) {
  const value = dependencies?.[name];
  return {
    attempted: value?.attempted === true,
    durationMs: telemetryDuration(value?.durationMs),
    status: TELEMETRY_STATUSES.has(value?.status) ? value.status : 'UNAVAILABLE',
  };
}

export function pruneWorkerCycleTelemetry(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM worker_cycle_metrics WHERE observed_at < ?').run(cutoff);
  db.prepare(`
    DELETE FROM worker_cycle_metrics
    WHERE id NOT IN (SELECT id FROM worker_cycle_metrics ORDER BY id DESC LIMIT ?)
  `).run(MAX_TELEMETRY_ROWS - 64);
}

function persistWorkerCycleTelemetry(db, telemetry, now, pruneHistory, workerState = null) {
  const observedAt = now.toISOString();
  const errorClass = TELEMETRY_ERROR_CLASSES.has(telemetry.errorClass) ? telemetry.errorClass : null;
  const broker = telemetryDependency(telemetry.dependencies, 'brokerHealth');
  const market = telemetryDependency(telemetry.dependencies, 'marketData');
  const news = telemetryDependency(telemetry.dependencies, 'newsCalendar');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO worker_cycle_metrics (
        observed_at, duration_ms, error_class,
        broker_health_attempted, broker_health_duration_ms, broker_health_status,
        market_data_attempted, market_data_duration_ms, market_data_status,
        news_calendar_attempted, news_calendar_duration_ms, news_calendar_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observedAt, telemetryDuration(telemetry.durationMs), errorClass,
      Number(broker.attempted), broker.durationMs, broker.status,
      Number(market.attempted), market.durationMs, market.status,
      Number(news.attempted), news.durationMs, news.status,
    );
    if (workerState) writeState(db, 'worker', workerState, observedAt);
    if (pruneHistory) pruneWorkerCycleTelemetry(db, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function providerLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  const looksSensitive = /(?:token|secret|api[-_.]?key|auth|password|credential|bearer)/i.test(label);
  return label.length <= 24 && !looksSensitive && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) ? label : 'unknown';
}

function reasonCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function positive(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
}

function nonNegative(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function candleValid(candle) {
  const values = ['open', 'high', 'low', 'close'].map((key) => Number(candle?.[key]));
  if (!values.every(Number.isFinite)) return false;
  const [open, high, low, close] = values;
  const time = Date.parse(candle?.closedAt ?? '');
  return Number.isFinite(time) && low <= Math.min(open, close) && high >= Math.max(open, close) && high >= low
    && (candle.tickVolume == null || (Number.isInteger(Number(candle.tickVolume)) && Number(candle.tickVolume) >= 0));
}

function normalizeRiskMetrics(value, provider, receivedAt) {
  const observedTime = typeof value?.observedAt === 'string' ? Date.parse(value.observedAt) : NaN;
  const currency = typeof value?.currency === 'string' ? value.currency.trim().toUpperCase() : '';
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && Number.isFinite(observedTime)
    && positive(value.equity)
    && /^[A-Z]{3,8}$/.test(currency)
    && nonNegative(value.dailyLossR)
    && nonNegative(value.drawdownPct)
    && (value.maxSpreadPrice == null || positive(value.maxSpreadPrice));
  if (!valid) return {
    updatedAt: receivedAt,
    value: { equity: null, currency: null, dailyLossR: null, drawdownPct: null, maxSpreadPrice: null, source: provider, invalidReason: 'RISK_STATE_INVALID' },
  };
  return {
    updatedAt: new Date(observedTime).toISOString(),
    value: {
      equity: Number(value.equity), currency, dailyLossR: Number(value.dailyLossR),
      drawdownPct: Number(value.drawdownPct),
      maxSpreadPrice: value.maxSpreadPrice == null ? null : Number(value.maxSpreadPrice),
      source: provider,
    },
  };
}

function valuesMatch(row, candle) {
  return Number(row.open_price) === Number(candle.open)
    && Number(row.high_price) === Number(candle.high)
    && Number(row.low_price) === Number(candle.low)
    && Number(row.close_price) === Number(candle.close)
    && (row.tick_volume == null ? candle.tickVolume == null : Number(row.tick_volume) === Number(candle.tickVolume));
}

async function withDeadline(operation, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('Provider deadline exceeded.');
      error.code = 'DEPENDENCY_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class UnavailableMarketDataProvider {
  async readHealth(now = new Date()) {
    return {
      source: 'none',
      status: 'OFFLINE',
      checkedAt: now.toISOString(),
      reason: 'No broker or market-data provider has been selected or configured.',
    };
  }

  async readMarketData() {
    return null;
  }
}

export class UnavailableNewsCalendarProvider {
  async readCalendar(now = new Date()) {
    return {
      source: 'none', status: 'OFFLINE', fetchedAt: null, events: [],
      reason: `No news-calendar provider has been selected or configured as of ${now.toISOString()}.`,
    };
  }
}

export function persistMarketData(db, payload, providerName, now = new Date()) {
  const safeProvider = providerLabel(providerName);
  const source = String(payload?.source ?? '').trim().toUpperCase();
  const quote = payload?.quote;
  if (!isAcceptedMarketSource(source) || quote?.symbol !== 'XAUUSD' || String(quote?.source ?? '').toUpperCase() !== source
    || !positive(quote.bid) || !positive(quote.ask) || Number(quote.ask) < Number(quote.bid)) {
    throw new TypeError('Provider must return a normalized market XAUUSD quote with valid bid/ask.');
  }
  const observedTime = Date.parse(quote.observedAt ?? '');
  if (!Number.isFinite(observedTime)) throw new TypeError('Provider quote must include a valid observation timestamp.');
  const ageMs = now.getTime() - observedTime;
  const fresh = ageMs >= 0 && ageMs <= 30_000;
  const receivedAt = now.toISOString();
  const quoteStatus = fresh ? source : 'STALE';
  const insertCandle = db.prepare(`
    INSERT OR IGNORE INTO candles (symbol, timeframe, closed_at, open_price, high_price, low_price, close_price, tick_volume, source, quality)
    VALUES ('XAUUSD', ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED_CLOSED')
  `);
  const insertSnapshot = db.prepare(`
    INSERT INTO market_snapshots (id, symbol, source, status, bid, ask, last, observed_at, received_at, details_json)
    VALUES (?, 'XAUUSD', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let insertedCandles = 0;
  let rejectedCandles = 0;
  let conflicts = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    insertSnapshot.run(randomUUID(), source, quoteStatus, String(quote.bid), String(quote.ask), quote.last == null ? null : String(quote.last),
      new Date(observedTime).toISOString(), receivedAt, JSON.stringify({ provider: safeProvider, spreadModel: payload.paperSpread ?? null, reason: fresh ? null : 'QUOTE_STALE_OR_CLOCK_SKEW' }));

    for (const [timeframe, supplied] of Object.entries(payload.candlesByTimeframe ?? {})) {
      if (!TIMEFRAMES.has(timeframe) || !Array.isArray(supplied)) { rejectedCandles += 1; continue; }
      const candles = [...supplied].slice(-MAX_CANDLES_PER_FRAME).sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? ''));
      for (const candle of candles) {
        const closedAt = Date.parse(candle?.closedAt ?? '');
        if (!candleValid(candle) || String(candle.source ?? '').toUpperCase() !== source || closedAt > now.getTime()) {
          rejectedCandles += 1;
          continue;
        }
        const result = insertCandle.run(timeframe, new Date(closedAt).toISOString(), String(candle.open), String(candle.high),
          String(candle.low), String(candle.close), candle.tickVolume == null ? null : Number(candle.tickVolume), source);
        if (Number(result.changes) > 0) {
          insertedCandles += 1;
          continue;
        }
        const existing = db.prepare(`
          SELECT open_price, high_price, low_price, close_price, tick_volume, quality FROM candles
          WHERE symbol = 'XAUUSD' AND timeframe = ? AND closed_at = ?
        `).get(timeframe, new Date(closedAt).toISOString());
        if (existing && !valuesMatch(existing, candle) && existing.quality !== 'CONFLICT') {
          db.prepare(`UPDATE candles SET quality = 'CONFLICT' WHERE symbol = 'XAUUSD' AND timeframe = ? AND closed_at = ?`)
            .run(timeframe, new Date(closedAt).toISOString());
          appendAudit(db, {
            actor: 'market-data-adapter', eventType: 'MARKET_CANDLE_CONFLICT', entityType: 'candle',
            entityId: `XAUUSD:${timeframe}:${new Date(closedAt).toISOString()}`,
            reason: 'A repeated closed-candle timestamp contained different OHLCV values; stored values were not overwritten.',
            metadata: { timeframe, closedAt: new Date(closedAt).toISOString(), provider: safeProvider },
          }, receivedAt);
          conflicts += 1;
        }
      }
    }
    writeState(db, 'marketDataHealth', {
      status: fresh ? 'HEALTHY' : 'STALE', provider: safeProvider, source, checkedAt: receivedAt,
      insertedCandles, rejectedCandles, conflicts,
      reason: !fresh ? 'QUOTE_STALE_OR_CLOCK_SKEW' : rejectedCandles || conflicts ? 'CANDLE_QUALITY_ISSUES' : null,
    }, receivedAt);
    if (payload.riskMetrics != null) {
      const riskMetrics = normalizeRiskMetrics(payload.riskMetrics, safeProvider, receivedAt);
      writeState(db, 'riskMetrics', riskMetrics.value, riskMetrics.updatedAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    symbol: 'XAUUSD', source, status: quoteStatus,
    dataFreshness: fresh ? 'FRESH' : 'STALE', bid: Number(quote.bid), ask: Number(quote.ask),
    last: quote.last == null ? null : Number(quote.last), observedAt: new Date(observedTime).toISOString(),
    receivedAt, reason: fresh ? null : 'QUOTE_STALE_OR_CLOCK_SKEW',
  };
}

export function persistNewsCalendar(db, payload, providerName, now = new Date()) {
  const safeProvider = providerLabel(providerName);
  const fetchedAtMs = Date.parse(payload?.fetchedAt ?? '');
  const fetchedAgeMs = Number.isFinite(fetchedAtMs) ? now.getTime() - fetchedAtMs : Number.POSITIVE_INFINITY;
  const fresh = payload?.status === 'HEALTHY' && Number.isFinite(fetchedAtMs)
    && fetchedAgeMs >= 0 && fetchedAgeMs <= 30 * 60_000 && Array.isArray(payload.events);
  const status = fresh ? 'HEALTHY' : payload?.status === 'OFFLINE' ? 'OFFLINE' : 'STALE';
  const at = now.toISOString();
  const previous = readState(db, 'newsProvider', { status: 'OFFLINE', fetchedAt: null, source: 'none' });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (fresh) {
      if (payload.events.length > 500) throw new TypeError('News provider returned too many events.');
      const save = db.prepare(`
        INSERT INTO news_events (id, source, event_key, title, currency, impact, scheduled_at, fetched_at, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET title = excluded.title, currency = excluded.currency,
          impact = excluded.impact, scheduled_at = excluded.scheduled_at, fetched_at = excluded.fetched_at,
          details_json = excluded.details_json
      `);
      for (const event of payload.events) {
        if (!event || typeof event.title !== 'string' || !event.title.trim()
          || typeof event.currency !== 'string' || typeof event.impact !== 'string'
          || !Number.isFinite(Date.parse(event.scheduledAt ?? ''))) throw new TypeError('News event schema or time is invalid.');
        const key = event.eventKey ?? event.event_key ?? createHash('sha256')
          .update(`${event.currency}|${event.title}|${event.scheduledAt}`).digest('hex');
        save.run(randomUUID(), safeProvider, key, event.title.trim(), event.currency.toUpperCase(), event.impact.toUpperCase(),
          new Date(Date.parse(event.scheduledAt)).toISOString(), new Date(fetchedAtMs).toISOString(), JSON.stringify({ category: event.category ?? null }));
      }
    }
    const next = {
      status,
      source: safeProvider,
      fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : previous.fetchedAt ?? null,
      reason: fresh ? null : reasonCode(payload?.reason, status === 'STALE' ? 'NEWS_DATA_STALE_OR_AMBIGUOUS' : 'NEWS_SOURCE_UNAVAILABLE'),
    };
    writeState(db, 'newsProvider', next, at);
    if (`${previous.status}:${previous.source}` !== `${next.status}:${next.source}`) {
      appendAudit(db, {
        actor: 'news-calendar-adapter', eventType: 'NEWS_PROVIDER_STATE_CHANGED',
        reason: next.reason ?? 'News calendar provider state changed.',
        metadata: { from: previous.status, to: next.status, source: safeProvider },
      }, at);
    }
    db.exec('COMMIT');
    return next;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function freshClosedM15(db, now) {
  const candle = db.prepare(`
    SELECT closed_at, source, quality FROM candles WHERE symbol = 'XAUUSD' AND timeframe = 'M15'
    ORDER BY closed_at DESC LIMIT 1
  `).get();
  if (!candle || !isAcceptedMarketSource(candle.source) || candle.quality !== 'VERIFIED_CLOSED') return null;
  const closedAt = Date.parse(candle.closed_at);
  if (!Number.isFinite(closedAt) || closedAt > now.getTime() || now.getTime() - closedAt > 30 * 60_000) return null;
  const quote = db.prepare(`SELECT source, status, observed_at, received_at FROM market_snapshots ORDER BY received_at DESC LIMIT 1`).get();
  const observed = Date.parse(quote?.observed_at ?? '');
  const received = Date.parse(quote?.received_at ?? '');
  if (!isFreshMarketSnapshot(quote) || !Number.isFinite(observed) || !Number.isFinite(received)
    || now.getTime() < observed || now.getTime() - observed > 30_000 || now.getTime() < received || now.getTime() - received > 30_000) return null;
  return candle.closed_at;
}

function executionCosts(db) {
  return readState(db, 'paperCosts', null);
}

function persistHealth(db, health, now, previousState) {
  const safeSource = providerLabel(health.source);
  const safeReason = reasonCode(health.reason, health.status === 'HEALTHY' ? null : 'PROVIDER_HEALTH_UNAVAILABLE');
  db.prepare(`
    INSERT INTO broker_health (source, status, checked_at, details_json) VALUES (?, ?, ?, ?)
    `).run(safeSource, health.status, now.toISOString(), JSON.stringify({ reason: safeReason }));
  const nextState = `${safeSource}:${health.status}`;
  if (nextState !== previousState) {
    appendAudit(db, {
      eventType: 'BROKER_HEALTH_CHANGED', correlationId: randomUUID(), reason: safeReason ?? 'Provider health state changed.',
      metadata: { source: safeSource, status: health.status },
    }, now.toISOString());
  }
  return nextState;
}

export class PaperWorker {
  #timer = null;
  #lastHealthState = null;
  #tickInFlight = false;
  #lastNewsAttemptAt = null;
  #telemetryPruneDue = true;
  #telemetryTicksSincePrune = 0;

  constructor({
    db,
    provider = new UnavailableMarketDataProvider(),
    newsProvider = new UnavailableNewsCalendarProvider(),
    clock = () => new Date(),
    intervalMs = 15_000,
    newsRefreshMs = NEWS_REFRESH_MS,
    dependencyTimeoutMs = TIMEOUT_MS,
    monotonicNow = () => performance.now(),
  }) {
    this.db = db;
    this.provider = provider;
    this.newsProvider = newsProvider;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.newsRefreshMs = newsRefreshMs;
    this.dependencyTimeoutMs = dependencyTimeoutMs;
    this.monotonicNow = monotonicNow;
    this.running = false;
  }

  async #readHealth(now) {
    try {
      const health = await withDeadline((signal) => this.provider.readHealth(now, { signal }), this.dependencyTimeoutMs);
      if (!health || !['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE'].includes(health.status)) throw new TypeError('Provider health schema is invalid.');
      return {
        source: providerLabel(health.source),
        status: health.status,
        checkedAt: now.toISOString(),
        reason: reasonCode(health.reason, health.status === 'HEALTHY' ? null : 'PROVIDER_HEALTH_UNAVAILABLE'),
      };
    } catch (error) {
      return {
        source: 'unknown', status: 'OFFLINE', checkedAt: now.toISOString(),
        reason: error.code === 'DEPENDENCY_TIMEOUT' ? 'PROVIDER_HEALTH_TIMEOUT' : 'PROVIDER_HEALTH_UNAVAILABLE',
      };
    }
  }

  async #refreshNews(now) {
    const previous = readState(this.db, 'newsProvider', { status: 'OFFLINE', source: 'none', fetchedAt: null });
    if (this.#lastNewsAttemptAt && now.getTime() - this.#lastNewsAttemptAt < this.newsRefreshMs) {
      return { state: previous, attempted: false, durationMs: null };
    }
    this.#lastNewsAttemptAt = now.getTime();
    const startedAt = this.monotonicNow();
    let providerDurationMs = null;
    try {
      const payload = await withDeadline((signal) => this.newsProvider.readCalendar(now, { signal }), this.dependencyTimeoutMs);
      providerDurationMs = elapsedMilliseconds(startedAt, this.monotonicNow());
      return {
        state: persistNewsCalendar(this.db, payload, String(payload?.source ?? 'unknown'), now),
        attempted: true,
        durationMs: providerDurationMs,
      };
    } catch (error) {
      providerDurationMs ??= elapsedMilliseconds(startedAt, this.monotonicNow());
      const failed = {
        status: 'OFFLINE', source: previous.source ?? 'unknown', fetchedAt: previous.fetchedAt ?? null,
        reason: error.code === 'DEPENDENCY_TIMEOUT' ? 'NEWS_PROVIDER_TIMEOUT' : 'NEWS_PROVIDER_UNAVAILABLE',
      };
      const at = now.toISOString();
      writeState(this.db, 'newsProvider', failed, at);
      if (`${previous.status}:${previous.source}` !== `${failed.status}:${failed.source}`) {
        appendAudit(this.db, { eventType: 'NEWS_PROVIDER_STATE_CHANGED', reason: failed.reason, metadata: { from: previous.status, to: failed.status } }, at);
      }
      return { state: failed, attempted: true, durationMs: providerDurationMs };
    }
  }

  async tick() {
    if (this.#tickInFlight) return { skipped: true, reason: 'WORKER_TICK_ALREADY_RUNNING' };
    this.#tickInFlight = true;
    const now = this.clock();
    const tickStartedAt = this.monotonicNow();
    let telemetryRecordAttempted = false;
    const dependencies = {
      brokerHealth: { attempted: true, durationMs: null, status: 'NOT_ATTEMPTED' },
      marketData: { attempted: false, durationMs: null, status: 'SKIPPED' },
      newsCalendar: { attempted: false, durationMs: null, status: 'NOT_ATTEMPTED' },
    };
    try {
      const healthStartedAt = this.monotonicNow();
      const health = await this.#readHealth(now);
      dependencies.brokerHealth = {
        attempted: true, durationMs: elapsedMilliseconds(healthStartedAt, this.monotonicNow()), status: health.status,
      };
      this.#lastHealthState = persistHealth(this.db, health, now, this.#lastHealthState);
      let quote = null;
      let marketDataResult = null;
      if (health.status === 'HEALTHY' && typeof this.provider.readMarketData === 'function') {
        dependencies.marketData = { attempted: true, durationMs: null, status: 'UNAVAILABLE' };
        const marketStartedAt = this.monotonicNow();
        try {
          const payload = await withDeadline((signal) => this.provider.readMarketData(now, { signal }), this.dependencyTimeoutMs);
          dependencies.marketData.durationMs = elapsedMilliseconds(marketStartedAt, this.monotonicNow());
          if (payload) {
            quote = persistMarketData(this.db, payload, health.source, now);
            marketDataResult = readState(this.db, 'marketDataHealth', null);
            dependencies.marketData.status = quote.dataFreshness === 'FRESH' ? 'HEALTHY' : 'STALE';
          } else {
            dependencies.marketData.status = 'NO_DATA';
          }
        } catch (error) {
          dependencies.marketData.durationMs = elapsedMilliseconds(marketStartedAt, this.monotonicNow());
          dependencies.marketData.status = error.code === 'DEPENDENCY_TIMEOUT' ? 'TIMEOUT' : 'ERROR';
          const previous = readState(this.db, 'marketDataHealth', {});
          const failed = {
            status: 'UNAVAILABLE', provider: health.source, checkedAt: now.toISOString(),
            reason: error.code === 'DEPENDENCY_TIMEOUT' ? 'MARKET_DATA_TIMEOUT' : 'MARKET_DATA_INVALID_OR_UNAVAILABLE',
          };
          writeState(this.db, 'marketDataHealth', failed, now.toISOString());
          if (previous.status !== failed.status || previous.reason !== failed.reason) {
            appendAudit(this.db, { eventType: 'MARKET_DATA_INGESTION_FAILED', reason: failed.reason, metadata: { provider: health.source } }, now.toISOString());
          }
        }
      }

      const newsResult = await this.#refreshNews(now);
      const news = newsResult.state;
      dependencies.newsCalendar = {
        attempted: newsResult.attempted,
        durationMs: newsResult.durationMs,
        status: newsResult.attempted ? news.status : 'CACHED',
      };
      let scan = null;
      const closeAt = freshClosedM15(this.db, now);
      const lastScanClose = readState(this.db, 'lastWorkerM15Close', null);
      if (closeAt && closeAt !== lastScanClose) {
        const evaluated = executePaperScan(this.db, now);
        writeState(this.db, 'lastWorkerM15Close', closeAt, now.toISOString());
        scan = { scanId: evaluated.persisted.scanId, status: evaluated.persisted.status, replayed: evaluated.persisted.replayed, reasons: evaluated.persisted.reasons };
      }

      const execution = reconcilePaperExecution(this.db, {
        quote,
        costs: executionCosts(this.db),
        paperMode: readState(this.db, 'paperMode', true) === true,
        now,
      });
      const telemetry = {
        durationMs: elapsedMilliseconds(tickStartedAt, this.monotonicNow()),
        dependencies,
        errorClass: null,
      };
      persistWorkerCycleTelemetry(this.db, telemetry, now,
        this.#telemetryPruneDue || this.#telemetryTicksSincePrune >= 63,
        { running: true, heartbeatAt: now.toISOString(), error: null, lastTick: telemetry });
      telemetryRecordAttempted = true;
      this.#telemetryPruneDue = false;
      this.#telemetryTicksSincePrune = (this.#telemetryTicksSincePrune + 1) % 64;
      return { health, market: marketDataResult, news, scan, execution, telemetry, skipped: false };
    } catch (error) {
      const knownErrorCodes = new Set(['DEPENDENCY_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_IOERR', 'BROKER_REJECTED', 'RATE_LIMITED']);
      const errorClass = knownErrorCodes.has(error?.code) ? error.code : error instanceof TypeError ? 'TYPE_ERROR' : 'UNCLASSIFIED';
      const telemetry = {
        durationMs: elapsedMilliseconds(tickStartedAt, this.monotonicNow()),
        dependencies,
        errorClass,
      };
      let persistenceFailure = false;
      if (!telemetryRecordAttempted) {
        telemetryRecordAttempted = true;
        try {
          persistWorkerCycleTelemetry(this.db, telemetry, now,
            this.#telemetryPruneDue || this.#telemetryTicksSincePrune >= 63);
          this.#telemetryPruneDue = false;
          this.#telemetryTicksSincePrune = (this.#telemetryTicksSincePrune + 1) % 64;
        } catch {
          persistenceFailure = true;
        }
      }
      try {
        writeState(this.db, 'worker', { running: false, heartbeatAt: now.toISOString(), error: 'WORKER_TICK_FAILED', lastTick: telemetry }, now.toISOString());
        writeState(this.db, 'entryPaused', true, now.toISOString());
      } catch {
        persistenceFailure = true;
      }
      try {
        appendAudit(this.db, {
          eventType: 'WORKER_TICK_FAILED',
          reason: 'Worker tick failed safely; raw dependency error details were redacted.',
          metadata: { errorClass, persistenceFailure },
        }, now.toISOString());
      } catch {
        persistenceFailure = true;
      }
      return { skipped: false, error: 'WORKER_TICK_FAILED', errorClass, persistenceFailure, telemetry };
    } finally {
      this.#tickInFlight = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.running = false;
  }
}
