import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendAudit, openDatabase, readState, runIdempotent, writeState } from './database.mjs';
import { config } from './config.mjs';
import { PaperWorker, UnavailableMarketDataProvider } from './worker.mjs';
import { TwelveDataMarketDataProvider } from './providers/twelvedata-market-provider.mjs';
import { ForexFactoryNewsCalendarProvider } from './providers/forexfactory-news-provider.mjs';
import { isAcceptedMarketSource, isFreshMarketSnapshot, MARKET_QUOTE_MAX_AGE_MS } from './market-source.mjs';
import { executePaperScan } from './services/paper-scan-service.mjs';
import { atr, calculateIndicators, ema } from './domain/indicators.mjs';
import { evaluateRiskGuard } from './domain/risk.mjs';
import { activeSessions } from './domain/market-sessions.mjs';
import { aggregateTradeStatistics } from './domain/statistics.mjs';
import { loadFreshRiskMetrics } from './services/risk-state-service.mjs';
import { latestPaperEquitySnapshot } from './services/paper-equity-service.mjs';
import { TelegramService } from './services/telegram-service.mjs';
import { closePaperPosition } from './services/paper-lifecycle-service.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');
const MIGRATIONS = resolve(ROOT, 'src', 'migrations');
const MAX_BODY_BYTES = 32 * 1024;
const TIMEFRAME_MS = Object.freeze({ M15: 15 * 60_000, M30: 30 * 60_000, H1: 60 * 60_000, H4: 4 * 60 * 60_000 });
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);
const OBSERVED_ROUTES = new Map([
  ['/', 'dashboard.html'],
  ['/app.js', 'asset.app'],
  ['/styles.css', 'asset.styles'],
  ['/healthz', 'health'],
  ['/bot/status', 'bot.status'],
  ['/api/dashboard', 'dashboard.api'],
  ['/api/market', 'market'],
  ['/api/market/overview', 'market.overview'],
  ['/api/market/candles', 'market.candles'],
  ['/api/mtf/latest', 'mtf.latest'],
  ['/api/news', 'news'],
  ['/api/positions', 'positions'],
  ['/api/orders', 'orders'],
  ['/api/trades', 'trades'],
  ['/api/stats', 'stats'],
  ['/api/audit', 'audit'],
  ['/api/telemetry/worker', 'telemetry.worker'],
  ['/api/scan/latest', 'scan.latest'],
  ['/api/actions/pause', 'action.pause'],
  ['/api/actions/resume', 'action.resume'],
  ['/api/actions/scan', 'action.scan'],
  ['/api/actions/paper', 'action.paper'],
  ['/api/actions/research', 'action.research'],
  ['/api/actions/close', 'action.close'],
]);

function observedRouteLabel(pathname) {
  if (OBSERVED_ROUTES.has(pathname)) return OBSERVED_ROUTES.get(pathname);
  if (pathname.startsWith('/api/actions/')) return 'action.other';
  if (pathname.startsWith('/api/')) return 'api.other';
  return 'static.other';
}

export function initializeDatabase(db, now = new Date()) {
  const at = now.toISOString();
  if (readState(db, 'paperMode', null) === null) writeState(db, 'paperMode', config.paperMode, at);
  writeState(db, 'entryPaused', true, at);
  writeState(db, 'worker', { running: false, heartbeatAt: null }, at);
  db.prepare(`
    INSERT OR IGNORE INTO config_versions (version, config_json, rationale, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    config.strategyVersion,
    JSON.stringify({
      profileId: config.strategyProfileId,
      strategyParameters: config.strategyParameters,
      parameterRationale: config.parameterRationale,
      risk: config.risk,
    }),
    'Content-fingerprinted paper profile with explicit threshold rationales; values are conservative engineering defaults, not evidence of a profitable strategy.',
    at,
  );
}

function latestBrokerHealth(db) {
  return db.prepare(`
    SELECT source, status, checked_at, details_json FROM broker_health ORDER BY id DESC LIMIT 1
  `).get() ?? {
    source: config.marketSource,
    status: 'OFFLINE',
    checked_at: null,
    details_json: JSON.stringify({ reason: 'No market-data provider is configured.' }),
  };
}

function createMarketProvider() {
  if (config.marketProvider === 'twelvedata') return new TwelveDataMarketDataProvider();
  return new UnavailableMarketDataProvider();
}

function createNewsProvider() {
  if (config.newsSource === 'forexfactory') return new ForexFactoryNewsCalendarProvider();
  return undefined;
}

function parseJson(value, fallback = null) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

function marketOverview(row) {
  const details = parseJson(row?.details_json, {});
  return details && typeof details === 'object' && !Array.isArray(details) ? details.marketOverview ?? null : null;
}

function positionLastMarkAt(snapshotValue, now) {
  const snapshot = parseJson(snapshotValue, {});
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const lastFill = Array.isArray(snapshot.fills) ? snapshot.fills.at(-1) : null;
  const candidates = [
    snapshot.lastMarketQuote?.observedAt,
    snapshot.lastFill?.quote?.observedAt,
    lastFill?.quote?.observedAt,
  ];
  for (const value of candidates) {
    const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(milliseconds) && milliseconds <= now.getTime()) return new Date(milliseconds).toISOString();
  }
  return null;
}

const SENSITIVE_RESPONSE_KEY = /token|secret|credential|password|authorization|api.?key|private.?key|cookie/i;
const MAX_PUBLIC_RESPONSE_DEPTH = 32;

function redactSensitiveResponseFields(value, key = '', depth = 0) {
  if (SENSITIVE_RESPONSE_KEY.test(key)) return '[REDACTED]';
  if (depth >= MAX_PUBLIC_RESPONSE_DEPTH) return '[DEPTH_LIMIT]';
  if (typeof value === 'string' && /(?:_json|Json)$/i.test(key)) {
    try { return JSON.stringify(redactSensitiveResponseFields(JSON.parse(value), '', depth + 1)); } catch { return '[UNREADABLE]'; }
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveResponseFields(item, '', depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactSensitiveResponseFields(child, childKey, depth + 1),
    ]));
  }
  return value;
}

function publicWorkerTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const validStatuses = new Set(['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED']);
  const safeDuration = (duration) => duration !== null && duration !== undefined && duration !== ''
    && Number.isFinite(Number(duration)) && Number(duration) >= 0 && Number(duration) <= 600_000
    ? Number(Number(duration).toFixed(1)) : null;
  const dependencies = {};
  for (const name of ['brokerHealth', 'marketData', 'newsCalendar']) {
    const metric = value.dependencies?.[name];
    if (!metric || typeof metric !== 'object' || Array.isArray(metric)) continue;
    dependencies[name] = {
      attempted: metric.attempted === true,
      durationMs: safeDuration(metric.durationMs),
      status: validStatuses.has(metric.status) ? metric.status : 'UNAVAILABLE',
    };
  }
  const errorClass = typeof value.errorClass === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorClass)
    ? value.errorClass : null;
  return { durationMs: safeDuration(value.durationMs), dependencies, errorClass };
}

const TELEMETRY_STATUS_VALUES = new Set([
  'HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED',
]);
const MAX_TELEMETRY_WINDOW_ROWS = 6_000;

function percentile(values, quantile) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)].toFixed(1));
}

function workerDependencySummary(rows, name) {
  const attempts = rows.filter((row) => row[`${name}_attempted`] === 1);
  const statuses = {};
  for (const row of attempts) {
    const rawStatus = row[`${name}_status`];
    const status = TELEMETRY_STATUS_VALUES.has(rawStatus) ? rawStatus : 'UNAVAILABLE';
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return {
    attempts: attempts.length,
    failures: attempts.filter((row) => row[`${name}_status`] !== 'HEALTHY').length,
    p95DurationMs: percentile(attempts.map((row) => row[`${name}_duration_ms`]), 0.95),
    statuses,
  };
}

function workerTelemetrySnapshot(db, now, window = '1h') {
  const windowMs = window === '24h' ? 24 * 60 * 60_000 : 60 * 60_000;
  const from = new Date(now.getTime() - windowMs).toISOString();
  const until = now.toISOString();
  const queried = db.prepare(`
    SELECT observed_at, duration_ms, error_class,
      broker_health_attempted, broker_health_duration_ms, broker_health_status,
      market_data_attempted, market_data_duration_ms, market_data_status,
      news_calendar_attempted, news_calendar_duration_ms, news_calendar_status
    FROM worker_cycle_metrics
    WHERE observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at DESC LIMIT ?
  `).all(from, until, MAX_TELEMETRY_WINDOW_ROWS + 1);
  const truncated = queried.length > MAX_TELEMETRY_WINDOW_ROWS;
  const rows = queried.slice(0, MAX_TELEMETRY_WINDOW_ROWS);
  const failedCycles = rows.filter((row) => row.error_class !== null).length;
  const durations = rows.map((row) => row.duration_ms).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    source: 'LOCAL_SQLITE_WORKER_CYCLES',
    window,
    from,
    until,
    latestSampleAt: rows[0]?.observed_at ?? null,
    sampleCount: rows.length,
    truncated,
    failedCycles,
    errorRatePct: rows.length ? Number((failedCycles / rows.length * 100).toFixed(1)) : null,
    durationMs: {
      p50: percentile(durations, 0.50),
      p95: percentile(durations, 0.95),
      max: durations.length ? Number(Math.max(...durations).toFixed(1)) : null,
    },
    dependencies: {
      brokerHealth: workerDependencySummary(rows, 'broker_health'),
      marketData: workerDependencySummary(rows, 'market_data'),
      newsCalendar: workerDependencySummary(rows, 'news_calendar'),
    },
  };
}

function latestMtfSnapshot(db) {
  const scan = db.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`).get();
  if (!scan) return { status: 'UNAVAILABLE', scan: null, analyses: [], signal: null, riskDecision: null };
  const analyses = db.prepare(`
    SELECT timeframe, direction, strength, votes_json, indicators_json, rejection_reasons_json, candle_closed_at
    FROM timeframe_analyses WHERE scan_id = ?
    ORDER BY CASE timeframe WHEN 'H4' THEN 1 WHEN 'H1' THEN 2 WHEN 'M30' THEN 3 WHEN 'M15' THEN 4 ELSE 5 END
  `).all(scan.id).map((item) => ({
    timeframe: item.timeframe,
    direction: item.direction,
    strength: item.strength,
    votes: parseJson(item.votes_json, []),
    indicators: parseJson(item.indicators_json),
    rejectionReasons: parseJson(item.rejection_reasons_json, []),
    candleClosedAt: item.candle_closed_at,
  }));
  const signalRow = db.prepare(`
    SELECT direction, status, entry_price, stop_price, take_profit_1, take_profit_2, score, snapshot_json
    FROM signals WHERE scan_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(scan.id);
  const riskRow = db.prepare(`
    SELECT allowed, reasons_json, inputs_json, config_version, created_at
    FROM risk_decisions WHERE scan_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(scan.id);
  return {
    status: scan.status,
    decision: {
      direction: scan.direction,
      score: scan.score,
      confluencePct: scan.confluence_pct,
      snapshot: parseJson(scan.decision_snapshot_json, {}),
    },
    scan: {
      id: scan.id,
      startedAt: scan.started_at,
      completedAt: scan.completed_at,
      reasons: parseJson(scan.reason_json, []),
      configVersion: scan.config_version,
      correlationId: scan.correlation_id,
    },
    analyses,
    signal: signalRow ? {
      direction: signalRow.direction,
      status: signalRow.status,
      entry: Number(signalRow.entry_price),
      stop: Number(signalRow.stop_price),
      takeProfit1: Number(signalRow.take_profit_1),
      takeProfit2: Number(signalRow.take_profit_2),
      score: signalRow.score,
      snapshot: parseJson(signalRow.snapshot_json),
    } : null,
    riskDecision: riskRow ? {
      allowed: Boolean(riskRow.allowed),
      reasons: parseJson(riskRow.reasons_json, []),
      inputs: parseJson(riskRow.inputs_json),
      configVersion: riskRow.config_version,
      createdAt: riskRow.created_at,
    } : null,
  };
}

function marketCandlesSnapshot(db, timeframe, now = new Date(), symbol = 'XAUUSD') {
  const duration = TIMEFRAME_MS[timeframe];
  if (!duration) throw new TypeError('A supported timeframe is required: M15, M30, H1, or H4.');
  if (!config.symbols.includes(symbol)) throw new TypeError('An enabled market symbol is required.');
  const candles = db.prepare(`
    SELECT open_price AS open, high_price AS high, low_price AS low, close_price AS close,
      tick_volume AS tickVolume, closed_at AS closedAt, source
    FROM candles
    WHERE symbol = ? AND timeframe = ? AND source IN ('BROKER', 'MARKET_DATA') AND quality = 'VERIFIED_CLOSED'
    ORDER BY closed_at DESC LIMIT 200
  `).all(symbol, timeframe).reverse().map((item) => ({
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close),
    tickVolume: item.tickVolume == null ? null : Number(item.tickVolume), closedAt: item.closedAt, source: item.source,
  })).filter((item) => [item.open, item.high, item.low, item.close].every(Number.isFinite)
    && item.low <= Math.min(item.open, item.close) && item.high >= Math.max(item.open, item.close) && item.high >= item.low);
  const latest = candles.at(-1) ?? null;
  const ageMs = latest ? now.getTime() - Date.parse(latest.closedAt) : Number.POSITIVE_INFINITY;
  const dataFreshness = latest && ageMs >= 0 && ageMs <= duration * 2 ? 'FRESH' : latest ? 'STALE' : 'UNAVAILABLE';
  const closes = candles.map((item) => item.close);
  const atrValues = atr(candles, 14);
  const currentAtr = atrValues.at(-1) ?? null;
  const priorAtr = atrValues.slice(0, -1).filter((value) => Number.isFinite(value)).slice(-50).sort((a, b) => a - b);
  const medianAtr = priorAtr.length >= 20
    ? (priorAtr.length % 2 ? priorAtr[(priorAtr.length - 1) / 2] : (priorAtr[priorAtr.length / 2 - 1] + priorAtr[priorAtr.length / 2]) / 2)
    : null;
  const volatilityRatio = Number.isFinite(currentAtr) && medianAtr > 0 ? currentAtr / medianAtr : null;
  const volatility = volatilityRatio == null ? 'UNAVAILABLE'
    : volatilityRatio < 0.75 ? 'LOW'
      : volatilityRatio <= 1.5 ? 'NORMAL'
        : volatilityRatio <= 2.5 ? 'HIGH' : 'EXTREME';
  const utcDate = now.toISOString().slice(0, 10);
  const today = candles.filter((item) => item.closedAt.slice(0, 10) === utcDate);
  const indicators = calculateIndicators(candles);
  return {
    symbol, timeframe, source: latest?.source ?? 'none',
    dataFreshness, lastClosedAt: latest?.closedAt ?? null,
    candleCount: candles.length, requiredCandles: 100, sufficientHistory: candles.length >= 100,
    reason: !latest ? 'NO_VERIFIED_MARKET_CANDLES' : dataFreshness === 'STALE' ? 'CANDLE_HISTORY_STALE' : candles.length < 100 ? 'INSUFFICIENT_CLOSED_CANDLES' : null,
    candles,
    indicators,
    ema9Series: ema(closes, 9),
    ema21Series: ema(closes, 21),
    volatility: { bucket: volatility, atr14: currentAtr, baselineAtrMedian: medianAtr, ratio: volatilityRatio, baselineCount: priorAtr.length, method: 'Current ATR(14) divided by median of up to 50 preceding ATR(14) values; <0.75 low, <=1.5 normal, <=2.5 high, otherwise extreme.' },
    utcDayRange: today.length ? { high: Math.max(...today.map((item) => item.high)), low: Math.min(...today.map((item) => item.low)), date: utcDate } : null,
    tickVolumeRatio: indicators.tickVolumeRatio,
  };
}

function marketWatchlistSnapshot(db, now = new Date()) {
  return config.symbols.map((symbol) => {
    const latest = db.prepare(`
      SELECT symbol, source, status, bid, ask, last, observed_at, received_at, details_json
      FROM market_snapshots WHERE symbol = ? ORDER BY received_at DESC LIMIT 1
    `).get(symbol) ?? null;
    const observedAt = latest?.observed_at ? Date.parse(latest.observed_at) : NaN;
    const receivedAt = latest?.received_at ? Date.parse(latest.received_at) : NaN;
    const fresh = isFreshMarketSnapshot(latest)
      && Number.isFinite(observedAt) && Number.isFinite(receivedAt)
      && now.getTime() >= observedAt && now.getTime() - observedAt <= MARKET_QUOTE_MAX_AGE_MS
      && now.getTime() >= receivedAt && now.getTime() - receivedAt <= MARKET_QUOTE_MAX_AGE_MS;
    const lastCandle = db.prepare(`
      SELECT closed_at, source, quality FROM candles WHERE symbol = ? AND timeframe = 'M15'
      ORDER BY closed_at DESC LIMIT 1
    `).get(symbol) ?? null;
    return {
      symbol,
      source: latest?.source ?? 'none',
      status: latest?.status ?? 'UNAVAILABLE',
      dataFreshness: fresh ? 'FRESH' : latest ? 'STALE' : 'UNAVAILABLE',
      quote: latest ? { bid: latest.bid, ask: latest.ask, last: latest.last, observedAt: latest.observed_at } : null,
      overview: marketOverview(latest),
      spreadPrice: latest?.bid != null && latest?.ask != null ? Number(latest.ask) - Number(latest.bid) : null,
      lastClosedCandleAt: lastCandle?.closed_at ?? null,
      candleSource: lastCandle?.source ?? null,
      candleQuality: lastCandle?.quality ?? null,
      reason: latest ? parseJson(latest.details_json).reason ?? null : 'NO_MARKET_SNAPSHOT',
    };
  });
}

export function dashboardSnapshot(db, now = new Date()) {
  const health = latestBrokerHealth(db);
  const worker = readState(db, 'worker', { running: false, heartbeatAt: null });
  const telegramState = readState(db, 'telegram', {
    status: config.telegram.enabled ? 'STARTING' : 'DISABLED',
    updatedAt: null, lastUpdateAt: null, lastErrorCode: null,
  });
  const heartbeatTime = Date.parse(worker.heartbeatAt ?? '');
  const isHeartbeatFresh = Number.isFinite(heartbeatTime)
    && heartbeatTime <= now.getTime() && now.getTime() - heartbeatTime <= 45_000;
  const workerReady = Boolean(worker.running && isHeartbeatFresh);
  const positions = db.prepare(`
    SELECT id, symbol, side, status, quantity_open_lots, entry_price, mark_price, stop_price,
      take_profit_1, take_profit_2, opened_at, realized_pnl, unrealized_pnl, tp1_hit, snapshot_json
    FROM positions WHERE status IN ('OPEN', 'PARTIAL') ORDER BY opened_at DESC
  `).all().map(({ snapshot_json, ...position }) => ({
    ...position,
    lastMarkAt: positionLastMarkAt(snapshot_json, now),
  }));
  const orders = db.prepare(`
    SELECT id, symbol, side, order_type, status, quantity_lots, entry_price, stop_price,
      take_profit_1, take_profit_2, expires_at, created_at
    FROM orders WHERE status IN ('PENDING', 'PARTIAL') ORDER BY created_at DESC
  `).all();
  const trades = db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n;
  const statistics = aggregateStats(db, now);
  const lastScan = db.prepare(`
    SELECT id, started_at, completed_at, status, reason_json FROM scan_runs ORDER BY started_at DESC LIMIT 1
  `).get() ?? null;
  const latestMarket = db.prepare(`
    SELECT symbol, source, status, bid, ask, last, observed_at, received_at, details_json
    FROM market_snapshots ORDER BY received_at DESC LIMIT 1
  `).get() ?? null;
  const marketDataHealth = readState(db, 'marketDataHealth', { status: 'UNAVAILABLE', reason: null });
  const receivedAt = latestMarket?.received_at ? Date.parse(latestMarket.received_at) : NaN;
  const observedAt = latestMarket?.observed_at ? Date.parse(latestMarket.observed_at) : NaN;
  const marketFresh = isFreshMarketSnapshot(latestMarket)
    && Number.isFinite(receivedAt)
    && Number.isFinite(observedAt)
    && now.getTime() >= receivedAt
    && now.getTime() - receivedAt <= MARKET_QUOTE_MAX_AGE_MS
    && now.getTime() >= observedAt
    && now.getTime() - observedAt <= MARKET_QUOTE_MAX_AGE_MS;
  const lastClosedCandle = db.prepare(`
    SELECT closed_at, source, quality FROM candles WHERE symbol = 'XAUUSD' AND timeframe = 'M15' ORDER BY closed_at DESC LIMIT 1
  `).get() ?? null;
  const news = readState(db, 'newsProvider', { status: 'OFFLINE', source: 'none', fetchedAt: null, reason: 'No news-calendar provider is configured.' });
  const newsFetchedAt = news.fetchedAt ? Date.parse(news.fetchedAt) : NaN;
  const newsFresh = news.status === 'HEALTHY' && Number.isFinite(newsFetchedAt)
    && now.getTime() >= newsFetchedAt && now.getTime() - newsFetchedAt <= 30 * 60_000;
  const instrument = readState(db, 'instrumentMetadata', null);
  const spreadPrice = latestMarket?.bid != null && latestMarket?.ask != null ? Number(latestMarket.ask) - Number(latestMarket.bid) : null;
  const riskState = loadFreshRiskMetrics(db, now);
  const paperEquity = latestPaperEquitySnapshot(db);
  const riskGuard = evaluateRiskGuard({
    dailyLossR: riskState.freshness === 'FRESH' ? riskState.dailyLossR : null,
    drawdownPct: riskState.freshness === 'FRESH' ? riskState.drawdownPct : null,
    openRiskPct: riskState.freshness === 'FRESH' ? riskState.openRiskPct : null,
    limits: config.risk,
  });
  const reason = JSON.parse(health.details_json).reason ?? null;
  const brokerOnline = health.status === 'HEALTHY';
  const entryPaused = readState(db, 'entryPaused', true);
  const paperMode = readState(db, 'paperMode', config.paperMode);
  const botState = !brokerOnline ? 'BROKER OFFLINE'
    : !marketFresh ? latestMarket ? 'DATA STALE' : 'PAPER CHECKING'
      : !newsFresh ? 'NEWS UNAVAILABLE'
          : !paperMode ? 'MONITORING ONLY'
          : entryPaused || riskState.freshness !== 'FRESH' || !riskGuard.allowed ? 'ENTRY PAUSED'
            : !workerReady ? 'PAPER CHECKING' : 'PAPER ON';
  const stateReason = !brokerOnline ? reason
    : !marketFresh ? 'Verified fresh broker quote is unavailable.'
      : !newsFresh ? news.reason ?? 'News calendar is unavailable or stale; entries fail closed.'
        : !paperMode ? 'Paper execution is off; only read-only monitoring is available.'
          : riskState.freshness !== 'FRESH' ? riskState.reason ?? 'Risk state is unavailable or stale; entries fail closed.'
              : !riskGuard.allowed ? riskGuard.reasons.join(', ')
              : entryPaused ? 'Entries are paused.'
                : !workerReady ? 'Worker heartbeat is not fresh; paper entry checks are unavailable.'
                  : 'Paper entries are enabled; every setup must still pass all entry gates.';
  const heartbeatAt = worker.heartbeatAt ?? null;

  return {
    generatedAt: now.toISOString(),
    app: { name: 'NEXORA XAU FOREX AUTO TRADING', buildId: config.buildId, schemaVersion: config.schemaVersion },
    trading: {
      mode: 'PAPER',
      paperMode,
      paperModeState: paperMode ? 'PAPER MODE ENABLED' : 'PAPER OFF',
      operatingMode: paperMode ? 'PAPER' : 'MONITORING ONLY',
      liveTradingEnabled: false,
      state: botState,
      statusFlags: [...new Set([
        botState,
        ...(!paperMode ? ['PAPER OFF', 'MONITORING ONLY'] : []),
        'LIVE DISABLED',
      ])],
      entryPaused,
      entriesAllowed: botState === 'PAPER ON',
      stateReason,
    },
    broker: {
      name: config.brokerName === 'none' ? 'Not selected' : config.brokerName,
      source: health.source,
      connected: brokerOnline,
      status: health.status,
      checkedAt: health.checked_at,
      reason,
    },
    market: {
      symbol: 'XAUUSD',
      source: latestMarket?.source ?? health.source,
      status: latestMarket?.status ?? marketDataHealth.status ?? 'UNAVAILABLE',
      dataFreshness: marketFresh ? 'FRESH' : latestMarket ? 'STALE' : 'UNAVAILABLE',
      quote: latestMarket ? {
        bid: latestMarket.bid,
        ask: latestMarket.ask,
        last: latestMarket.last,
        observedAt: latestMarket.observed_at,
      } : null,
      overview: marketOverview(latestMarket),
      dataContract: {
        marketData: 'READ_ONLY_VPS_PROXY',
        execution: 'PAPER_ONLY',
        provider: latestMarket ? config.marketSource : 'none',
        marketType: 'SPOT_OTC',
        derivatives: 'NOT_APPLICABLE_FOR_SPOT_XAU',
      },
      lastClosedCandleAt: lastClosedCandle?.closed_at ?? null,
      candleSource: lastClosedCandle?.source ?? null,
      candleQuality: lastClosedCandle?.quality ?? null,
      spreadPrice: Number.isFinite(spreadPrice) && spreadPrice >= 0 ? spreadPrice : null,
      spreadPoints: Number.isFinite(spreadPrice) && Number(instrument?.tickSize) > 0 ? spreadPrice / Number(instrument.tickSize) : null,
      session: activeSessions(now),
      reason: latestMarket ? JSON.parse(latestMarket.details_json).reason ?? null : marketDataHealth.reason ?? reason,
    },
    symbols: config.symbols,
    markets: marketWatchlistSnapshot(db, now),
    news: { status: newsFresh ? 'HEALTHY' : news.status === 'HEALTHY' ? 'STALE' : news.status, source: news.source, fetchedAt: news.fetchedAt, reason: newsFresh ? null : news.reason },
    account: {
      balance: paperEquity?.balance ?? null,
      equity: riskState.freshness === 'FRESH' ? riskState.equity : paperEquity?.equity ?? null,
      dailyPnl: statistics.periods.today.sampleCount > 0 ? statistics.periods.today.realizedNetPnl : null,
      freeMargin: null, usedMargin: null, marginLevel: null, leverage: null,
      currency: riskState.freshness === 'FRESH' ? riskState.currency : paperEquity?.currency ?? statistics.currency,
    },
    risk: {
      limits: config.risk,
      dailyLossR: riskState.freshness === 'FRESH' ? riskState.dailyLossR : null,
      drawdownPct: riskState.freshness === 'FRESH' ? riskState.drawdownPct : paperEquity?.drawdownPct ?? null,
      openRiskPct: riskState.freshness === 'FRESH' ? riskState.openRiskPct : null,
      freshness: riskState.freshness,
      updatedAt: riskState.updatedAt,
      reasons: riskState.freshness === 'FRESH' ? riskGuard.reasons : [riskState.reason ?? 'RISK_STATE_UNAVAILABLE'],
      status: riskState.freshness !== 'FRESH' ? 'RISK STATE UNAVAILABLE'
        : !riskGuard.allowed ? 'RISK GUARD TRIPPED' : brokerOnline ? 'CHECKS REQUIRED' : 'ENTRY BLOCKED',
    },
    paperEquity,
    worker: {
      running: workerReady,
      heartbeatAt,
      lastTick: publicWorkerTelemetry(worker.lastTick),
      telemetryLastHour: workerTelemetrySnapshot(db, now, '1h'),
    },
    telegram: {
      enabled: config.telegram.enabled,
      configured: Boolean(config.telegram.token && config.telegram.allowedUserIds.length && config.telegram.allowedChatIds.length),
      notificationsEnabled: config.telegram.notificationsEnabled,
      status: telegramState.status,
      updatedAt: telegramState.updatedAt,
      lastUpdateAt: telegramState.lastUpdateAt,
      lastErrorCode: telegramState.lastErrorCode,
      pendingNotifications: db.prepare('SELECT COUNT(*) AS count FROM telegram_notification_outbox WHERE sent_at IS NULL').get().count,
    },
    counts: {
      openPositions: positions.length,
      pendingOrders: orders.length,
      closedTrades: trades,
      forwardPaperTrades: statistics.forwardEvidence.closedBrokerPaperTrades,
      forwardPaperTradesRequired: statistics.forwardEvidence.required,
    },
    positions,
    orders,
    lastScan: lastScan ? { ...lastScan, reasons: JSON.parse(lastScan.reason_json) } : null,
    statistics,
  };
}

function readinessReasons(snapshot) {
  const reasons = [];
  const paperMarketFeedConnected = snapshot.market?.dataFreshness === 'FRESH'
    && isAcceptedMarketSource(snapshot.market?.source);
  if (!snapshot.trading.paperMode) reasons.push('PAPER_MODE_DISABLED');
  if (!snapshot.worker.running) reasons.push('WORKER_NOT_READY');
  if (!snapshot.broker.connected && !paperMarketFeedConnected) reasons.push('BROKER_OFFLINE');
  if (snapshot.market.dataFreshness !== 'FRESH') reasons.push('MARKET_DATA_NOT_FRESH');
  if (snapshot.news.status !== 'HEALTHY') reasons.push('NEWS_NOT_READY');
  if (snapshot.risk.freshness !== 'FRESH') reasons.push('RISK_STATE_NOT_FRESH');
  else reasons.push(...snapshot.risk.reasons);
  return reasons;
}

function aggregateStats(db, now) {
  const rows = db.prepare(`
    SELECT t.*,
      EXISTS (SELECT 1 FROM position_events e WHERE e.position_id = t.position_id AND e.event_type = 'HIT_TP1') AS tp1_hit
    FROM trades t ORDER BY t.closed_at, t.id
  `).all().map((trade) => {
    const snapshot = parseJson(trade.snapshot_json, {}) ?? {};
    const classification = snapshot.classification ?? {};
    const marketSnapshot = snapshot.snapshots?.market ?? snapshot.market ?? {};
    const setupQuality = Array.isArray(classification.setupQuality)
      ? classification.setupQuality
      : String(trade.setup_quality ?? '').split('|').filter(Boolean);
    const marketConditions = Array.isArray(classification.marketConditions)
      ? classification.marketConditions
      : String(trade.market_condition ?? '').split('|').filter(Boolean);
    return {
      closedAt: trade.closed_at,
      netPnl: trade.net_pnl,
      pnlR: trade.pnl_r,
      side: trade.side,
      closeReason: trade.close_reason,
      setupQuality,
      marketConditions,
      timeframe: 'M15',
      spreadAtrRatio: classification.spreadAtrRatio,
      broker: marketSnapshot.source ?? 'UNAVAILABLE',
      symbol: trade.symbol,
      entryDelaySeconds: trade.entry_delay_seconds,
      durationSeconds: trade.duration_seconds,
      mfe: trade.mfe,
      mae: trade.mae,
      tp1Hit: Boolean(trade.tp1_hit),
      currency: snapshot.executionCosts?.accountCurrency ?? snapshot.paperCosts?.accountCurrency
        ?? snapshot.account?.currency ?? snapshot.snapshots?.account?.currency ?? null,
    };
  });
  const pendingExpiredCount = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'EXPIRED'").get().n;
  const result = aggregateTradeStatistics(rows, { now, pendingExpiredCount });
  const closedBrokerPaperTrades = rows.filter((row) => row.broker === 'BROKER'
    && row.pnlR !== null && row.pnlR !== undefined && Number.isFinite(Number(row.pnlR))
    && Boolean(row.currency)
    && row.setupQuality.some((tag) => /^MTF_[0-4]_OF_4$/.test(tag))).length;
  return {
    ...result,
    forwardEvidence: {
      closedBrokerPaperTrades,
      required: 100,
      milestoneReached: closedBrokerPaperTrades >= 100,
      disclaimer: 'Operational paper-history milestone only; not strategy validation or trading authorization.',
    },
  };
}

function jsonResponse(res, status, body) {
  const data = Buffer.from(JSON.stringify(redactSensitiveResponseFields(body)));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  res.end(data);
}

export function validLocalHost(hostHeader = '') {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function requestIsSameOrigin(req) {
  const originHeader = req.headers.origin;
  if (originHeader) {
    try {
      const origin = new URL(originHeader);
      const target = new URL(`http://${req.headers.host}`);
      return origin.origin === target.origin;
    } catch {
      return false;
    }
  }
  const referer = req.headers.referer;
  if (!referer) return true;
  try {
    return new URL(referer).origin === new URL(`http://${req.headers.host}`).origin;
  } catch {
    return false;
  }
}

function requestHasValidControlToken(req, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) return false;
  const match = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ''));
  if (!match) return false;
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  const suppliedDigest = createHash('sha256').update(match[1]).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value;
  } catch {
    throw Object.assign(new Error('Request body must be a valid JSON object.'), { statusCode: 400 });
  }
}

function auditEvents(db, limit = 25) {
  return db.prepare(`
    SELECT id, actor, event_type, correlation_id, entity_type, entity_id, reason, config_version, created_at, metadata_json
    FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(limit).map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json) }));
}

function staticResponse(pathname, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return jsonResponse(res, 400, { error: 'Invalid path encoding.' });
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = resolve(DIST, `.${requested}`);
  if (filePath !== DIST && !filePath.startsWith(`${DIST}${sep}`)) {
    return jsonResponse(res, 400, { error: 'Invalid path.' });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return jsonResponse(res, 404, { error: 'Not found.' });
  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  res.end(data);
}

export function createNexoraServer({ db, clock = () => new Date(), operatorToken = config.operatorToken, researchRunner = null, logger = null }) {
  const controlToken = typeof operatorToken === 'string' && operatorToken.length >= 32 ? operatorToken : null;
  const researchInFlight = new Map();
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    let route = 'unparsed';
    const method = ['GET', 'HEAD', 'POST'].includes(req.method) ? req.method : 'OTHER';
    res.setHeader('X-Request-ID', requestId);
    res.once('finish', () => {
      if (typeof logger?.log !== 'function') return;
      try {
        logger.log(JSON.stringify({
          event: 'http_request_completed',
          requestId,
          method,
          route,
          status: res.statusCode,
          durationMs: Math.max(0, Number((performance.now() - requestStartedAt).toFixed(1))),
        }));
      } catch {
        // Diagnostics must never affect the local request or trading state.
      }
    });
    try {
      const now = clock();
      if (!validLocalHost(req.headers.host)) {
        route = 'host.rejected';
        return jsonResponse(res, 421, { error: 'Local-only service.' });
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      route = observedRouteLabel(url.pathname);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/healthz') {
        const snapshot = dashboardSnapshot(db, now);
        const reasons = readinessReasons(snapshot);
        return jsonResponse(res, 200, {
          liveness: 'ok',
          readiness: reasons.length ? 'not_ready' : 'ready',
          readinessReasons: reasons,
          database: 'connected',
          worker: snapshot.worker,
          broker: snapshot.broker,
          dataFreshness: snapshot.market.dataFreshness,
          buildId: config.buildId,
          schemaVersion: config.schemaVersion,
          controlActionsAvailable: Boolean(controlToken),
        });
      }

      if (method === 'GET' && ['/api/dashboard', '/bot/status'].includes(url.pathname)) {
        const body = dashboardSnapshot(db, now);
        body.control = {
          authConfigured: Boolean(controlToken),
          operatorAuthenticated: requestHasValidControlToken(req, controlToken),
        };
        return jsonResponse(res, 200, url.pathname === '/bot/status' ? body.trading : body);
      }
      if (method === 'GET' && url.pathname === '/api/telemetry/worker') {
        const window = url.searchParams.get('window') ?? '1h';
        if (!['1h', '24h'].includes(window)) return jsonResponse(res, 400, { error: 'TELEMETRY_WINDOW_INVALID' });
        return jsonResponse(res, 200, workerTelemetrySnapshot(db, now, window));
      }
      if (method === 'GET' && url.pathname === '/api/market') {
        return jsonResponse(res, 200, dashboardSnapshot(db, now).market);
      }
      if (method === 'GET' && url.pathname === '/api/market/overview') {
        return jsonResponse(res, 200, dashboardSnapshot(db, now).market);
      }
      if (method === 'GET' && url.pathname === '/api/market/candles') {
        const timeframe = url.searchParams.get('timeframe') ?? 'M15';
        const symbol = String(url.searchParams.get('symbol') ?? 'XAUUSD').trim().toUpperCase();
        if (!Object.hasOwn(TIMEFRAME_MS, timeframe)) {
          return jsonResponse(res, 400, { error: 'Unsupported timeframe. Use M15, M30, H1, or H4.' });
        }
        if (!config.symbols.includes(symbol)) return jsonResponse(res, 400, { error: 'Unsupported market symbol.' });
        return jsonResponse(res, 200, marketCandlesSnapshot(db, timeframe, now, symbol));
      }
      if (method === 'GET' && url.pathname === '/api/mtf/latest') {
        return jsonResponse(res, 200, latestMtfSnapshot(db));
      }
      if (method === 'GET' && url.pathname === '/api/news') {
        const snapshot = dashboardSnapshot(db, now).news;
        const events = db.prepare(`
          SELECT title, currency, impact, scheduled_at, source, fetched_at
          FROM news_events WHERE scheduled_at >= ? ORDER BY scheduled_at LIMIT 50
        `).all(new Date(now.getTime() - 60 * 60_000).toISOString());
        return jsonResponse(res, 200, { ...snapshot, events });
      }
      if (method === 'GET' && url.pathname === '/api/positions') {
        return jsonResponse(res, 200, db.prepare(`SELECT * FROM positions ORDER BY opened_at DESC LIMIT 100`).all()
          .map((position) => ({ ...position, lastMarkAt: positionLastMarkAt(position.snapshot_json, now) })));
      }
      if (method === 'GET' && url.pathname === '/api/orders') {
        return jsonResponse(res, 200, db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`).all());
      }
      if (method === 'GET' && url.pathname === '/api/trades') {
        return jsonResponse(res, 200, db.prepare(`SELECT * FROM trades ORDER BY closed_at DESC LIMIT 100`).all());
      }
      if (method === 'GET' && url.pathname === '/api/stats') {
        return jsonResponse(res, 200, aggregateStats(db, now));
      }
      if (method === 'GET' && url.pathname === '/api/equity/snapshots') {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)));
        const rows = db.prepare(`
          SELECT id, source, currency, balance, equity, realized_pnl AS realizedPnl,
            unrealized_pnl AS unrealizedPnl, drawdown_pct AS drawdownPct, observed_at AS observedAt
          FROM equity_snapshots ORDER BY observed_at DESC LIMIT ?
        `).all(Number.isFinite(limit) ? limit : 100);
        return jsonResponse(res, 200, { configured: config.paperStartingEquity != null, startingEquity: config.paperStartingEquity, currency: config.paperCurrency, snapshots: rows });
      }
      if (method === 'GET' && url.pathname === '/api/audit') {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)));
        return jsonResponse(res, 200, auditEvents(db, Number.isFinite(limit) ? limit : 25));
      }
      if (method === 'GET' && url.pathname === '/api/scan/latest') {
        return jsonResponse(res, 200, dashboardSnapshot(db, now).lastScan);
      }
      if (method === 'GET' && url.pathname.startsWith('/api/')) {
        return jsonResponse(res, 404, { error: 'API route not found.' });
      }

      if (method !== 'GET' && method !== 'HEAD') {
        if (!requestIsSameOrigin(req)) return jsonResponse(res, 403, { error: 'Cross-origin state changes are blocked.' });
        if (!controlToken) return jsonResponse(res, 503, { error: 'CONTROL_AUTH_NOT_CONFIGURED' });
        if (!requestHasValidControlToken(req, controlToken)) return jsonResponse(res, 401, { error: 'CONTROL_AUTH_REQUIRED' });
        return await handleAction(req, res, url.pathname, db, now, { researchRunner, researchInFlight, httpRequestId: requestId });
      }
      if (method === 'HEAD') {
        return jsonResponse(res, 405, { error: 'HEAD is not supported.' });
      }
      return staticResponse(url.pathname, res);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (!res.headersSent) jsonResponse(res, status, { error: status === 500 ? 'Request failed safely.' : error.message });
      else res.destroy();
    }
  });
}

function handleAction(req, res, pathname, db, now, { researchRunner, researchInFlight, httpRequestId }) {
  const actions = new Set(['/api/actions/pause', '/api/actions/resume', '/api/actions/scan', '/api/actions/paper', '/api/actions/research', '/api/actions/close']);
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed.' });
  if (!actions.has(pathname)) return jsonResponse(res, 404, { error: 'Action not found.' });

  return readJsonBody(req).then(async (body) => {
    const allowedFields = pathname === '/api/actions/paper' ? new Set(['enabled'])
      : pathname === '/api/actions/research' ? new Set(['datasetName', 'options'])
        : pathname === '/api/actions/close' ? new Set(['positionId']) : new Set();
    if (Object.keys(body).some((field) => !allowedFields.has(field))) return jsonResponse(res, 400, { error: 'Unexpected action fields.' });
    if (pathname === '/api/actions/paper' && Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean') {
      return jsonResponse(res, 400, { error: 'PAPER_MODE_VALUE_INVALID' });
    }
    if (pathname === '/api/actions/close' && (typeof body.positionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.positionId))) {
      return jsonResponse(res, 400, { error: 'PAPER_POSITION_ID_INVALID' });
    }
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') return jsonResponse(res, 400, { error: 'Idempotency-Key header is required.' });
    const scope = pathname.slice('/api/actions/'.length) + (pathname === '/api/actions/close' ? `:${body.positionId}` : '');
    if (pathname === '/api/actions/research') {
      const { runResearchDataset, summarizeResearchReport, validateResearchRequest } = await import('./services/research-service.mjs');
      const researchRequest = validateResearchRequest(body);
      const executeResearch = researchRunner ?? runResearchDataset;
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return jsonResponse(res, 400, { error: 'IDEMPOTENCY_KEY_INVALID' });
      const requestFingerprint = createHash('sha256').update(JSON.stringify({
        datasetName: researchRequest.datasetName,
        options: researchRequest.options,
      })).digest('hex');
      const existing = db.prepare(`
        SELECT response_status, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?
      `).get(scope, key);
      if (existing) {
        const cached = parseJson(existing.response_json, {});
        if (cached.idempotencyRequestFingerprint !== requestFingerprint) {
          return jsonResponse(res, 409, { error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' });
        }
        const { idempotencyRequestFingerprint: _fingerprint, ...responseBody } = cached;
        return jsonResponse(res, existing.response_status, { ...responseBody, idempotentReplay: true });
      }
      const active = researchInFlight.get(key);
      if (active) {
        if (active.requestFingerprint !== requestFingerprint) {
          return jsonResponse(res, 409, { error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' });
        }
        const result = await active.promise;
        const { idempotencyRequestFingerprint: _fingerprint, ...responseBody } = result.body;
        return jsonResponse(res, result.status, { ...responseBody, idempotentReplay: true });
      }
      const pending = { requestFingerprint, promise: null };
      pending.promise = (async () => {
        const report = await executeResearch(researchRequest);
        const summary = summarizeResearchReport(report);
        const storedBody = { ...summary, idempotencyRequestFingerprint: requestFingerprint };
        return runIdempotent(db, scope, key, now.toISOString(), () => {
          appendAudit(db, {
            actor: 'operator',
            eventType: 'HISTORICAL_RESEARCH_COMPLETED',
            correlationId: randomUUID(),
            entityType: 'research',
            entityId: summary.runId,
            reason: 'Operator requested an offline historical paper replay; this operation cannot enable or send live orders.',
            configVersion: summary.strategyVersion,
            metadata: {
              datasetName: researchRequest.datasetName,
              datasetId: summary.provenance.datasetId,
              dataClass: summary.provenance.dataClass,
              sourceAttestation: summary.provenance.sourceAttestation,
              datasetSha256: summary.provenance.datasetSha256,
              foldCount: summary.foldOptions.foldCount,
              buildId: summary.buildId,
              schemaVersionUsed: summary.schemaVersionUsed,
              strategyVersion: summary.strategyVersion,
              performanceEvidenceEligible: summary.performanceEvidenceEligible,
              reportSha256: summary.reportSha256,
              liveTradingEnabled: false,
              httpRequestId,
            },
          }, now.toISOString());
          return { status: 200, body: storedBody };
        });
      })();
      researchInFlight.set(key, pending);
      try {
        const result = await pending.promise;
        const { idempotencyRequestFingerprint: _fingerprint, ...responseBody } = result.body;
        return jsonResponse(res, result.status, { ...responseBody, idempotentReplay: result.replayed });
      } finally {
        if (researchInFlight.get(key) === pending) researchInFlight.delete(key);
      }
    }
    const correlationId = randomUUID();

    const result = runIdempotent(db, scope, key, now.toISOString(), () => {
      if (pathname === '/api/actions/pause') {
        writeState(db, 'entryPaused', true, now.toISOString());
        appendAudit(db, {
          eventType: 'ENTRY_PAUSED', correlationId, reason: 'Operator requested new paper entries to pause.',
          metadata: { httpRequestId },
        }, now.toISOString());
        return { status: 200, body: { ok: true, state: dashboardSnapshot(db, now).trading } };
      }
      if (pathname === '/api/actions/resume') {
        const snapshot = dashboardSnapshot(db, now);
        const reasons = readinessReasons(snapshot);
        if (reasons.length) {
          appendAudit(db, {
            eventType: 'ENTRY_RESUME_REJECTED', correlationId,
            reason: 'Paper readiness is incomplete; entry remains paused.',
            metadata: { readinessReasons: reasons, httpRequestId },
          }, now.toISOString());
          return { status: 409, body: { ok: false, error: 'READINESS_NOT_MET', readinessReasons: reasons, state: snapshot.trading } };
        }
        writeState(db, 'entryPaused', false, now.toISOString());
        appendAudit(db, {
          eventType: 'ENTRY_RESUMED', correlationId, reason: 'Operator resumed paper entries after readiness checks.',
          metadata: { httpRequestId },
        }, now.toISOString());
        return { status: 200, body: { ok: true, state: dashboardSnapshot(db, now).trading } };
      }
      if (pathname === '/api/actions/paper') {
        const enabled = body.enabled ?? true;
        writeState(db, 'paperMode', enabled, now.toISOString());
        if (!enabled) writeState(db, 'entryPaused', true, now.toISOString());
        appendAudit(db, {
          eventType: enabled ? 'PAPER_MODE_ENABLED_PAUSED' : 'PAPER_MODE_DISABLED',
          correlationId,
          reason: enabled
            ? 'Paper mode was enabled; new entries remain paused until separately resumed.'
            : 'Paper mode was disabled and new entries were paused; monitoring remains available.',
          metadata: { paperMode: enabled, entryPaused: enabled ? readState(db, 'entryPaused', true) : true, httpRequestId },
        }, now.toISOString());
        return { status: 200, body: { ok: true, mode: enabled ? 'PAPER' : 'MONITORING_ONLY', entryPaused: readState(db, 'entryPaused', true), liveTradingEnabled: false } };
      }
      if (pathname === '/api/actions/close') {
        const latest = db.prepare(`
          SELECT source, status, bid, ask, observed_at, received_at
          FROM market_snapshots WHERE symbol = 'XAUUSD' ORDER BY received_at DESC LIMIT 1
        `).get();
        const quote = latest ? {
          symbol: 'XAUUSD', source: latest.source,
          dataFreshness: isFreshMarketSnapshot(latest) ? 'FRESH' : 'STALE',
          bid: Number(latest.bid), ask: Number(latest.ask),
          observedAt: latest.observed_at, receivedAt: latest.received_at,
        } : null;
        const result = closePaperPosition(db, {
          positionId: body.positionId, quote, costs: readState(db, 'paperCosts', null), now, withinTransaction: true, httpRequestId,
        });
        if (!result.updated || !result.closed) {
          const reason = result.reason ?? 'POSITION_NOT_OPEN';
          appendAudit(db, {
            actor: 'operator', eventType: 'PAPER_POSITION_MANUAL_CLOSE_REJECTED', correlationId,
            entityType: 'position', entityId: body.positionId,
            reason: 'Manual paper close was safely rejected: ' + reason + '.',
            metadata: { rejectionCode: reason, quoteSource: latest?.source ?? null, liveTradingEnabled: false, httpRequestId },
          }, now.toISOString());
          return { status: 409, body: { ok: false, error: reason, liveTradingEnabled: false } };
        }
        return {
          status: 200,
          body: { ok: true, positionId: body.positionId, status: 'CLOSED', closeReason: 'MANUAL_CLOSE', liveTradingEnabled: false },
        };
      }

      const { result: scan, persisted } = executePaperScan(db, now, { transactional: false, httpRequestId });
      const status = persisted.accepted ? 200 : 409;
      return {
        status,
        body: {
          ok: persisted.accepted,
          status: persisted.status,
          scanId: persisted.scanId,
          direction: scan.direction,
          score: scan.score,
          confluencePct: scan.confluencePct,
          reasons: persisted.reasons,
          accepted: persisted.accepted,
          logicalReplay: persisted.replayed,
          liveTradingEnabled: false,
        },
      };
    });
    return jsonResponse(res, result.status, { ...result.body, idempotentReplay: result.replayed });
  }).catch((error) => {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : error instanceof TypeError ? 400 : 500;
    return jsonResponse(res, status, { error: status === 500 ? 'Action failed safely.' : error.message });
  });
}

function formatPrice(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
}

export function telegramDailySummary(db, date) {
  const stats = aggregateStats(db, new Date(date + 'T23:59:59.999Z'));
  const day = stats.periods.today;
  const net = day.realizedNetPnl == null || !stats.currency
    ? 'unavailable' : stats.currency + ' ' + Number(day.realizedNetPnl).toFixed(2);
  return [
    'NEXORA daily paper summary · UTC ' + date,
    'Closed trades: ' + day.sampleCount,
    'Realized net PnL: ' + net,
    'Realized loss: ' + Number(day.realizedLossR ?? 0).toFixed(2) + 'R',
    'Paper journal only; this is not strategy validation or a forecast.',
  ].join('\n');
}

export async function handleTelegramCommand({ command, updateId, db, operatorToken, baseUrl }) {
  const { name, args } = command;
  if (['help', 'start', 'status', 'positions', 'pending', 'stats', 'lastscan', 'pause', 'resume', 'scan'].includes(name)
    && args.length) return 'Format perintah tidak valid. Kirim /help.';
  if (name === 'help' || name === 'start') {
    return [
      'NEXORA · paper-only controls',
      '/status /positions /pending /stats /lastscan',
      '/pause /resume /paper on|off /scan',
      '/research <dataset.json> runs local offline replay.',
      'Resume stays blocked until all readiness gates pass. Live trading is unavailable.',
    ].join('\n');
  }
  if (name === 'status') {
    const snapshot = dashboardSnapshot(db);
    return [
      'NEXORA XAUUSD',
      'Mode: PAPER · live: disabled',
      'State: ' + snapshot.trading.state,
      'Entries: ' + (snapshot.trading.entryPaused ? 'paused' : snapshot.trading.entriesAllowed ? 'allowed' : 'blocked'),
      'Broker: ' + snapshot.broker.status + ' · market: ' + snapshot.market.dataFreshness,
      'News: ' + snapshot.news.status + ' · risk: ' + snapshot.risk.freshness,
      'Telegram bridge: ' + snapshot.telegram.status,
      'Open positions: ' + snapshot.counts.openPositions + ' · pending: ' + snapshot.counts.pendingOrders,
      'Reason: ' + snapshot.trading.stateReason,
    ].join('\n');
  }
  if (name === 'positions') {
    const rows = db.prepare("SELECT symbol, side, quantity_open_lots, entry_price, mark_price, stop_price, take_profit_1, unrealized_pnl FROM positions WHERE status IN ('OPEN', 'PARTIAL') ORDER BY opened_at DESC LIMIT 5").all();
    if (!rows.length) return 'Tidak ada posisi paper terbuka.';
    return ['Posisi paper (maks. 5):', ...rows.map((row) =>
      row.symbol + ' ' + row.side + ' · ' + row.quantity_open_lots + ' lot · entry ' + formatPrice(row.entry_price)
      + ' · mark ' + formatPrice(row.mark_price) + ' · SL ' + formatPrice(row.stop_price)
      + ' · TP1 ' + formatPrice(row.take_profit_1) + ' · uPnL ' + formatPrice(row.unrealized_pnl))].join('\n');
  }
  if (name === 'pending') {
    const rows = db.prepare("SELECT symbol, side, order_type, quantity_lots, entry_price, stop_price, take_profit_1, expires_at FROM orders WHERE status IN ('PENDING', 'PARTIAL') ORDER BY created_at DESC LIMIT 5").all();
    if (!rows.length) return 'Tidak ada pending paper order.';
    return ['Pending paper orders (maks. 5):', ...rows.map((row) =>
      row.symbol + ' ' + row.side + ' ' + row.order_type + ' · ' + row.quantity_lots + ' lot · entry '
      + formatPrice(row.entry_price) + ' · SL ' + formatPrice(row.stop_price) + ' · TP1 '
      + formatPrice(row.take_profit_1) + ' · expiry ' + row.expires_at)].join('\n');
  }
  if (name === 'stats') {
    const stats = aggregateStats(db, new Date());
    const today = stats.periods.today;
    const pnl = today.realizedNetPnl == null || !stats.currency
      ? 'unavailable' : stats.currency + ' ' + Number(today.realizedNetPnl).toFixed(2);
    const evidence = stats.metrics ? 'metrics are descriptive only; not a strategy forecast' : 'performance metrics withheld (minimum sample not met)';
    return [
      'Paper journal only · not a forecast',
      'Closed trades: ' + stats.sampleCount + ' · today: ' + today.sampleCount,
      'Today realized net PnL: ' + pnl,
      evidence,
      'Broker-fed forward milestone: ' + stats.forwardEvidence.closedBrokerPaperTrades + ' / ' + stats.forwardEvidence.required,
    ].join('\n');
  }
  if (name === 'lastscan') {
    const scan = dashboardSnapshot(db).lastScan;
    if (!scan) return 'Belum ada scan tercatat.';
    return [
      'Last scan: ' + scan.status + ' · ' + (scan.completed_at ?? scan.started_at),
      'Reason codes: ' + (scan.reasons?.slice(0, 5).join(', ') || 'none'),
    ].join('\n');
  }

  let actionPath;
  let actionBody = {};
  if (name === 'pause') actionPath = '/api/actions/pause';
  else if (name === 'resume') actionPath = '/api/actions/resume';
  else if (name === 'scan') actionPath = '/api/actions/scan';
  else if (name === 'paper' && args.length === 1 && ['on', 'off'].includes(args[0].toLowerCase())) {
    actionPath = '/api/actions/paper';
    actionBody = { enabled: args[0].toLowerCase() === 'on' };
  } else if (name === 'research' && args.length === 1) {
    actionPath = '/api/actions/research';
    actionBody = { datasetName: args[0] };
  } else {
    return 'Perintah tidak dikenal atau formatnya salah. Kirim /help.';
  }

  const response = await fetch(new URL(actionPath, baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      authorization: 'Bearer ' + operatorToken,
      'idempotency-key': 'telegram-update-' + updateId,
    },
    body: JSON.stringify(actionBody),
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    if (result.error === 'READINESS_NOT_MET') {
      return 'Resume ditolak; entry tetap paused. Gate: ' + (result.readinessReasons ?? []).join(', ');
    }
    return 'Aksi ditolak dengan aman: ' + (result.error ?? 'REQUEST_FAILED');
  }
  if (name === 'pause') return 'Entry paper dijeda. Live trading tetap tidak tersedia.';
  if (name === 'resume') return 'Permintaan resume diterima. Periksa status; entry hanya diizinkan setelah semua gate lolos.';
  if (name === 'paper') return 'Paper mode ' + (actionBody.enabled ? 'ON; entry tetap paused sampai resume terpisah.' : 'OFF; entry dijeda.');
  if (name === 'scan') return 'Scan paper selesai: ' + (result.status ?? 'UNKNOWN') + ' · ' + (result.reasons ?? []).join(', ');
  if (name === 'research') {
    const folds = (result.folds ?? []).map((fold) => 'fold ' + fold.fold + ': n=' + (fold.performance?.sampleCount ?? 0)).join('; ');
    return 'Replay lokal: ' + (result.status ?? 'UNKNOWN') + ' · ' + (folds || 'no fold summary')
      + ' · bukan forecast; live trading disabled.';
  }
  return 'Perintah selesai.';
}

function bootstrap() {
  let db = null;
  let worker = null;
  let telegram = null;
  let initialized = false;
  const lazyDatabase = new Proxy(Object.create(null), {
    get(_target, property) {
      if (!db) {
        const error = new Error('Database initialization has not completed.');
        error.code = 'DATABASE_NOT_READY';
        throw error;
      }
      const value = Reflect.get(db, property, db);
      return typeof value === 'function' ? value.bind(db) : value;
    },
  });
  const server = createNexoraServer({ db: lazyDatabase, logger: console });
  server.on('error', (error) => {
    console.error(JSON.stringify({
      event: initialized ? 'server_runtime_error' : 'server_start_failed',
      reason: error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'SERVER_ERROR',
    }));
    process.exitCode = 1;
    if (initialized) {
      worker?.stop();
      void Promise.resolve(telegram?.stop()).finally(() => {
        server.close(() => {
          db?.close();
          process.exit(1);
        });
      });
    }
  });
  server.listen(config.port, config.host, () => {
    try {
      db = openDatabase(config.dbPath, MIGRATIONS);
      initializeDatabase(db);
      appendAudit(db, {
        eventType: 'SERVICE_STARTED',
        reason: 'Local paper-only service started; live execution capability is absent.',
        metadata: { buildId: config.buildId, schemaVersion: config.schemaVersion },
      });
      worker = new PaperWorker({
        db,
        provider: createMarketProvider(),
        newsProvider: createNewsProvider(),
        symbols: config.symbols,
      });
      worker.start();
      initialized = true;
      const address = server.address();
      const baseUrl = 'http://' + config.host + ':' + address.port;
      telegram = new TelegramService({
        db,
        settings: config.telegram,
        dailySummaryProvider: (date) => telegramDailySummary(db, date),
        commandHandler: (context) => handleTelegramCommand({
          ...context, db, operatorToken: config.operatorToken, baseUrl,
        }),
      });
      telegram.start();
      console.log(JSON.stringify({ event: 'server_listening', url: `http://${config.host}:${address.port}`, liveTradingEnabled: false }));

      const shutdown = () => {
        worker.stop();
        void telegram.stop().finally(() => {
          server.close(() => {
            db.close();
            process.exit(0);
          });
        });
        setTimeout(() => process.exit(1), 5000).unref();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    } catch {
      worker?.stop();
      void telegram?.stop();
      db?.close();
      db = null;
      console.error(JSON.stringify({ event: 'server_start_failed', reason: 'DATABASE_INITIALIZATION_FAILED' }));
      process.exitCode = 1;
      server.close();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) bootstrap();
