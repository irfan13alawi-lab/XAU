import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendAudit, readState, writeState } from './database.mjs';
import { config } from './config.mjs';
import { executePaperScan } from './services/paper-scan-service.mjs';
import { reconcilePaperExecution } from './services/paper-lifecycle-service.mjs';
import { capturePaperEquitySnapshot, latestPaperEquitySnapshot } from './services/paper-equity-service.mjs';
import { isAcceptedMarketSource, isFreshMarketSnapshot, MARKET_QUOTE_MAX_AGE_MS } from './market-source.mjs';

const TIMEFRAMES = new Set(['M15', 'M30', 'H1', 'H4']);
const TIMEOUT_MS = 5_000;
// The calendar payload is weekly and the readiness contract allows 30 minutes
// of age. Refreshing every ten minutes avoids hammering a public feed while
// keeping the blackout gate current.
const NEWS_REFRESH_MS = 10 * 60_000;
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
const MARKET_SNAPSHOT_REFRESH_MS = 2 * 60_000;

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

function round(value, places = 8) {
  return Number(Number(value).toFixed(places));
}

function persistPaperRiskState(db, now = new Date()) {
  if (config.paperStartingEquity == null) return null;
  const snapshot = latestPaperEquitySnapshot(db);
  if (!snapshot || !positive(snapshot.equity) || !/^[A-Z]{3,8}$/.test(String(snapshot.currency ?? ''))) {
    writeState(db, 'riskMetrics', {
      equity: null,
      currency: null,
      dailyLossR: null,
      drawdownPct: null,
      maxSpreadPrice: config.risk.maxSpreadPrice,
      source: 'PAPER_SIMULATION',
      invalidReason: 'PAPER_EQUITY_NOT_CONFIGURED',
    }, now.toISOString());
    return null;
  }

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const realizedToday = Number(db.prepare(`
    SELECT COALESCE(SUM(CAST(net_pnl AS REAL)), 0) AS total
    FROM trades WHERE closed_at >= ? AND closed_at <= ?
  `).get(dayStart, now.toISOString())?.total ?? 0);
  const riskUnit = Number(snapshot.equity) * Number(config.risk.riskPerTradePct) / 100;
  const dailyLossR = Number.isFinite(realizedToday) && riskUnit > 0
    ? Math.max(0, round(-realizedToday / riskUnit, 6)) : 0;
  writeState(db, 'riskMetrics', {
    equity: Number(snapshot.equity),
    currency: String(snapshot.currency).trim().toUpperCase(),
    dailyLossR,
    drawdownPct: nonNegative(snapshot.drawdownPct) ? Number(snapshot.drawdownPct) : 0,
    maxSpreadPrice: config.risk.maxSpreadPrice,
    source: 'PAPER_SIMULATION',
  }, now.toISOString());
  return readState(db, 'riskMetrics', null);
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
  const quotes = Object.values(payload?.quotesBySymbol ?? (payload?.quote ? { [payload.quote.symbol ?? 'XAUUSD']: payload.quote } : {}));
  if (!isAcceptedMarketSource(source) || !quotes.length) {
    throw new TypeError('Provider must return at least one normalized market quote with valid bid/ask.');
  }
  const normalizedQuotes = quotes.map((quote) => {
    const symbol = String(quote?.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,12}$/.test(symbol) || String(quote?.source ?? '').toUpperCase() !== source
      || !positive(quote.bid) || !positive(quote.ask) || Number(quote.ask) < Number(quote.bid)) {
      throw new TypeError('Provider returned an invalid normalized market quote.');
    }
    const observedTime = Date.parse(quote.observedAt ?? '');
    if (!Number.isFinite(observedTime)) throw new TypeError('Provider quote must include a valid observation timestamp.');
    return { quote, symbol, observedTime, fresh: now.getTime() - observedTime >= 0 && now.getTime() - observedTime <= MARKET_QUOTE_MAX_AGE_MS };
  });
  const primary = normalizedQuotes.find((item) => item.symbol === 'XAUUSD') ?? normalizedQuotes[0];
  const receivedAt = now.toISOString();
  let insertedCandles = 0;
  let rejectedCandles = 0;
  let conflicts = 0;
  let repairedCandles = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const instrumentMetadataBySymbol = payload?.instrumentMetadataBySymbol ?? {};
    const paperCostsBySymbol = payload?.paperCostsBySymbol ?? {};
    for (const symbol of normalizedQuotes.map((item) => item.symbol)) {
      if (instrumentMetadataBySymbol[symbol]) writeState(db, `instrumentMetadata:${symbol}`, instrumentMetadataBySymbol[symbol], receivedAt);
      if (paperCostsBySymbol[symbol]) writeState(db, `paperCosts:${symbol}`, paperCostsBySymbol[symbol], receivedAt);
    }
    if (payload?.instrumentMetadata) writeState(db, 'instrumentMetadata', payload.instrumentMetadata, receivedAt);
    if (payload?.paperCosts) writeState(db, 'paperCosts', payload.paperCosts, receivedAt);
    for (const { quote, symbol, observedTime, fresh } of normalizedQuotes) {
      // The legacy snapshot schema names the fresh status BROKER. Keep the
      // actual source in `source` so MARKET_DATA remains distinguishable.
      const quoteStatus = fresh ? 'BROKER' : 'STALE';
      const marketOverview = payload?.marketOverviewBySymbol?.[symbol]
        ?? (symbol === 'XAUUSD' ? payload?.marketOverview : null)
        ?? null;
      const previousSnapshot = db.prepare(`
        SELECT source, status, bid, ask, last, observed_at, received_at
        FROM market_snapshots WHERE symbol = ? ORDER BY received_at DESC LIMIT 1
      `).get(symbol);
      const observedAt = new Date(observedTime).toISOString();
      const sameQuote = previousSnapshot
        && previousSnapshot.source === source
        && previousSnapshot.bid === String(quote.bid)
        && previousSnapshot.ask === String(quote.ask)
        && previousSnapshot.last === (quote.last == null ? null : String(quote.last))
        && previousSnapshot.observed_at === observedAt;
      const previousReceivedAt = Date.parse(previousSnapshot?.received_at ?? '');
      const snapshotRefreshDue = !Number.isFinite(previousReceivedAt)
        || now.getTime() - previousReceivedAt >= MARKET_SNAPSHOT_REFRESH_MS;
      if (!sameQuote || snapshotRefreshDue || previousSnapshot.status !== quoteStatus) {
        db.prepare(`
          INSERT INTO market_snapshots (id, symbol, source, status, bid, ask, last, observed_at, received_at, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), symbol, source, quoteStatus, String(quote.bid), String(quote.ask), quote.last == null ? null : String(quote.last),
          observedAt, receivedAt, JSON.stringify({
            provider: safeProvider,
            spreadModel: payload.paperSpread ?? null,
            marketOverview,
            reason: fresh ? null : 'QUOTE_STALE_OR_CLOCK_SKEW',
          }));
      }

      const candlesByTimeframe = payload?.persistCandlesBySymbol?.[symbol]
        ?? payload?.candlesBySymbol?.[symbol]
        ?? (symbol === 'XAUUSD' ? payload?.candlesByTimeframe : null)
        ?? {};
      for (const [timeframe, supplied] of Object.entries(candlesByTimeframe)) {
        if (!TIMEFRAMES.has(timeframe) || !Array.isArray(supplied)) { rejectedCandles += 1; continue; }
        const stored = db.prepare(`
          SELECT MAX(closed_at) AS latest_closed_at,
            MAX(CASE WHEN quality = 'CONFLICT' THEN closed_at ELSE NULL END) AS latest_conflict_at
          FROM candles WHERE symbol = ? AND timeframe = ?
        `).get(symbol, timeframe);
        const storedLatest = Date.parse(stored?.latest_closed_at ?? '');
        const storedConflict = Date.parse(stored?.latest_conflict_at ?? '');
        const boundary = Number.isFinite(storedConflict) ? storedConflict : storedLatest;
        const candles = [...supplied]
          .filter((candle) => !Number.isFinite(boundary) || Date.parse(candle?.closedAt ?? '') >= boundary)
          .slice(-MAX_CANDLES_PER_FRAME)
          .sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? ''));
        for (const candle of candles) {
          const closedAt = Date.parse(candle?.closedAt ?? '');
          if (!candleValid(candle) || String(candle.source ?? '').toUpperCase() !== source || closedAt > now.getTime()
            || (candle.symbol != null && String(candle.symbol).toUpperCase() !== symbol)) {
            rejectedCandles += 1;
            continue;
          }
          const result = db.prepare(`
            INSERT OR IGNORE INTO candles (symbol, timeframe, closed_at, open_price, high_price, low_price, close_price, tick_volume, source, quality)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED_CLOSED')
          `).run(symbol, timeframe, new Date(closedAt).toISOString(), String(candle.open), String(candle.high),
            String(candle.low), String(candle.close), candle.tickVolume == null ? null : Number(candle.tickVolume), source);
          if (Number(result.changes) > 0) {
            insertedCandles += 1;
            continue;
          }
          const existing = db.prepare(`
            SELECT open_price, high_price, low_price, close_price, tick_volume, quality FROM candles
            WHERE symbol = ? AND timeframe = ? AND closed_at = ?
          `).get(symbol, timeframe, new Date(closedAt).toISOString());
          if (existing?.quality === 'CONFLICT') {
            db.prepare(`
              UPDATE candles SET open_price = ?, high_price = ?, low_price = ?, close_price = ?, tick_volume = ?, quality = 'VERIFIED_CLOSED'
              WHERE symbol = ? AND timeframe = ? AND closed_at = ?
            `).run(String(candle.open), String(candle.high), String(candle.low), String(candle.close),
              candle.tickVolume == null ? null : Number(candle.tickVolume), symbol, timeframe, new Date(closedAt).toISOString());
            appendAudit(db, {
              actor: 'market-data-adapter', eventType: 'MARKET_CANDLE_CONFLICT_REPAIRED', entityType: 'candle',
              entityId: `${symbol}:${timeframe}:${new Date(closedAt).toISOString()}`,
              reason: 'A previously conflicted candle was replaced by a settled closed-provider value.',
              metadata: { symbol, timeframe, closedAt: new Date(closedAt).toISOString(), provider: safeProvider },
            }, receivedAt);
            repairedCandles += 1;
          } else if (existing && !valuesMatch(existing, candle)) {
            db.prepare(`UPDATE candles SET quality = 'CONFLICT' WHERE symbol = ? AND timeframe = ? AND closed_at = ?`)
              .run(symbol, timeframe, new Date(closedAt).toISOString());
            appendAudit(db, {
              actor: 'market-data-adapter', eventType: 'MARKET_CANDLE_CONFLICT', entityType: 'candle',
              entityId: `${symbol}:${timeframe}:${new Date(closedAt).toISOString()}`,
              reason: 'A repeated closed-candle timestamp contained different OHLCV values; stored values were not overwritten.',
              metadata: { symbol, timeframe, closedAt: new Date(closedAt).toISOString(), provider: safeProvider },
            }, receivedAt);
            conflicts += 1;
          }
        }
      }
    }
    const fresh = primary.fresh;
    writeState(db, 'marketDataHealth', {
      status: fresh ? 'HEALTHY' : 'STALE', provider: safeProvider, source, checkedAt: receivedAt,
      symbols: normalizedQuotes.map((item) => item.symbol), insertedCandles, rejectedCandles, conflicts, repairedCandles,
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
    symbol: primary.symbol, source, status: primary.fresh ? source : 'STALE',
    dataFreshness: primary.fresh ? 'FRESH' : 'STALE', bid: Number(primary.quote.bid), ask: Number(primary.quote.ask),
    last: primary.quote.last == null ? null : Number(primary.quote.last), observedAt: new Date(primary.observedTime).toISOString(),
    receivedAt, reason: primary.fresh ? null : 'QUOTE_STALE_OR_CLOCK_SKEW',
      quotesBySymbol: Object.fromEntries(normalizedQuotes.map(({ quote, symbol, observedTime, fresh }) => [symbol, {
        symbol, source, status: fresh ? source : 'STALE', dataFreshness: fresh ? 'FRESH' : 'STALE',
        bid: Number(quote.bid), ask: Number(quote.ask), last: quote.last == null ? null : Number(quote.last),
        observedAt: new Date(observedTime).toISOString(), receivedAt,
        overview: payload?.marketOverviewBySymbol?.[symbol]
          ?? (symbol === 'XAUUSD' ? payload?.marketOverview : null)
          ?? null,
      }])),
    marketOverview: payload?.marketOverview ?? null,
    marketOverviewBySymbol: payload?.marketOverviewBySymbol ?? {},
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

function freshClosedM15(db, now, symbol = 'XAUUSD') {
  const candle = db.prepare(`
    SELECT closed_at, source, quality FROM candles WHERE symbol = ? AND timeframe = 'M15'
    ORDER BY closed_at DESC LIMIT 1
  `).get(symbol);
  if (!candle || !isAcceptedMarketSource(candle.source) || candle.quality !== 'VERIFIED_CLOSED') return null;
  const closedAt = Date.parse(candle.closed_at);
  if (!Number.isFinite(closedAt) || closedAt > now.getTime() || now.getTime() - closedAt > 30 * 60_000) return null;
  const quote = db.prepare(`SELECT source, status, observed_at, received_at FROM market_snapshots WHERE symbol = ? ORDER BY received_at DESC LIMIT 1`).get(symbol);
  const observed = Date.parse(quote?.observed_at ?? '');
  const received = Date.parse(quote?.received_at ?? '');
  if (!isFreshMarketSnapshot(quote) || !Number.isFinite(observed) || !Number.isFinite(received)
    || now.getTime() < observed || now.getTime() - observed > MARKET_QUOTE_MAX_AGE_MS || now.getTime() < received || now.getTime() - received > MARKET_QUOTE_MAX_AGE_MS) return null;
  return candle.closed_at;
}

function executionCosts(db, symbol = 'XAUUSD') {
  return readState(db, `paperCosts:${symbol}`, readState(db, 'paperCosts', null));
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
    symbols = ['XAUUSD'],
  }) {
    this.db = db;
    this.provider = provider;
    this.newsProvider = newsProvider;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.newsRefreshMs = newsRefreshMs;
    this.dependencyTimeoutMs = dependencyTimeoutMs;
    this.monotonicNow = monotonicNow;
    this.symbols = Object.freeze([...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()))]);
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
      const previousFetchedAt = Date.parse(previous.fetchedAt ?? '');
      const cachedCalendarFresh = previous.source && previous.source !== 'none'
        && Number.isFinite(previousFetchedAt)
        && now.getTime() >= previousFetchedAt
        && now.getTime() - previousFetchedAt <= 30 * 60_000;
      const failed = {
        status: cachedCalendarFresh ? 'HEALTHY' : 'OFFLINE', source: previous.source ?? 'unknown', fetchedAt: previous.fetchedAt ?? null,
        reason: cachedCalendarFresh ? null : error.code === 'DEPENDENCY_TIMEOUT' ? 'NEWS_PROVIDER_TIMEOUT' : 'NEWS_PROVIDER_UNAVAILABLE',
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
      let quotesBySymbol = {};
      let marketDataResult = null;
      if (health.status === 'HEALTHY' && typeof this.provider.readMarketData === 'function') {
        dependencies.marketData = { attempted: true, durationMs: null, status: 'UNAVAILABLE' };
        const marketStartedAt = this.monotonicNow();
        try {
          const payload = await withDeadline((signal) => this.provider.readMarketData(now, { signal }), this.dependencyTimeoutMs);
          dependencies.marketData.durationMs = elapsedMilliseconds(marketStartedAt, this.monotonicNow());
          if (payload) {
            quote = persistMarketData(this.db, payload, health.source, now);
            quotesBySymbol = quote.quotesBySymbol ?? {};
            marketDataResult = readState(this.db, 'marketDataHealth', null);
            dependencies.marketData.status = quote.dataFreshness === 'FRESH' ? 'HEALTHY' : 'STALE';
          } else {
            dependencies.marketData.status = 'NO_DATA';
          }
        } catch (error) {
          dependencies.marketData.durationMs = elapsedMilliseconds(marketStartedAt, this.monotonicNow());
          dependencies.marketData.status = error.code === 'DEPENDENCY_TIMEOUT' ? 'TIMEOUT' : 'ERROR';
          const previous = readState(this.db, 'marketDataHealth', {});
          const safeReason = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '')
            ? error.code : 'MARKET_DATA_INVALID_OR_UNAVAILABLE';
          const failed = {
            status: 'UNAVAILABLE', provider: health.source, checkedAt: now.toISOString(),
            reason: error.code === 'DEPENDENCY_TIMEOUT' ? 'MARKET_DATA_TIMEOUT' : safeReason,
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
      const scans = [];
      for (const symbol of this.symbols) {
        const closeAt = freshClosedM15(this.db, now, symbol);
        const scanStateKey = symbol === 'XAUUSD' ? 'lastWorkerM15Close' : `lastWorkerM15Close:${symbol}`;
        const lastScanClose = readState(this.db, scanStateKey, null);
        if (closeAt && closeAt !== lastScanClose) {
          const evaluated = executePaperScan(this.db, now, { symbol });
          writeState(this.db, scanStateKey, closeAt, now.toISOString());
          scans.push({ symbol, scanId: evaluated.persisted.scanId, status: evaluated.persisted.status, replayed: evaluated.persisted.replayed, reasons: evaluated.persisted.reasons });
        }
      }

      const execution = { expired: 0, cancelled: 0, filled: 0, monitored: 0, closed: 0, skipped: 0, reasons: [] };
      const activeExecutionSymbols = new Set(this.db.prepare(`
        SELECT symbol FROM orders WHERE status IN ('PENDING', 'PARTIAL')
        UNION
        SELECT symbol FROM positions WHERE status IN ('OPEN', 'PARTIAL')
      `).all().map((row) => row.symbol));
      for (const symbol of this.symbols) {
        if (!activeExecutionSymbols.has(symbol)) continue;
        const symbolQuote = quotesBySymbol[symbol] ?? (symbol === 'XAUUSD' ? quote : null);
        const result = reconcilePaperExecution(this.db, {
          quote: symbolQuote,
          costs: executionCosts(this.db, symbol),
          paperMode: readState(this.db, 'paperMode', true) === true,
          now,
        });
        for (const field of ['expired', 'cancelled', 'filled', 'monitored', 'closed', 'skipped']) execution[field] += Number(result[field] ?? 0);
        for (const reason of result.reasons ?? []) if (!execution.reasons.includes(reason)) execution.reasons.push(reason);
      }
      capturePaperEquitySnapshot(this.db, now);
      if (readState(this.db, 'paperMode', config.paperMode) === true) persistPaperRiskState(this.db, now);
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
      return {
        health,
        market: marketDataResult,
        news,
        scan: scans.find((item) => item.symbol === 'XAUUSD') ?? null,
        scans,
        execution,
        telemetry,
        skipped: false,
      };
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
    // Provider priming is deliberately launched before the first tick so a
    // cold network connection cannot inflate worker latency. Until the
    // background feed publishes a valid quote, readHealth remains fail-closed.
    this.provider?.start?.();
    void this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    this.provider?.stop?.();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.running = false;
  }
}
