import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, writeState } from '../database.mjs';
import { initializeDatabase } from '../server.mjs';
import { aggregateTradeStatistics } from './statistics.mjs';
import { PaperWorker } from '../worker.mjs';
import { config } from '../config.mjs';

const TIMEFRAMES = Object.freeze(['H4', 'H1', 'M30', 'M15']);
const REQUIRED_HISTORY = 100;
const MAX_QUOTES = 50_000;
const MAX_CANDLES_PER_FRAME = 100_000;
const MAX_NEWS_SNAPSHOTS = 50_000;
const MAX_REPORTED_ARTIFACTS_PER_FOLD = 2_000;
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const positive = (value) => finite(value) && Number(value) > 0;

function instant(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function hashResearchDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new TypeError('RESEARCH_DATASET_INVALID');
  const { manifest, ...payload } = dataset;
  const safeManifest = { ...(manifest ?? {}) };
  delete safeManifest.sha256;
  return hashPayload({ ...payload, manifest: safeManifest });
}

export function verifyResearchReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  const { reportSha256, ...payload } = report;
  return typeof reportSha256 === 'string' && /^[a-f0-9]{64}$/i.test(reportSha256)
    && hashPayload(payload) === reportSha256.toLowerCase();
}

function assertProviderLabel(value, reason) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length > 24 || /(?:token|secret|api[-_.]?key|auth|password|credential|bearer)/i.test(label)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new TypeError(reason);
  return label;
}

function validateCandle(candle, source, lastQuoteAt) {
  const values = ['open', 'high', 'low', 'close'].map((key) => Number(candle?.[key]));
  const closedAt = instant(candle?.closedAt);
  if (!values.every((value) => Number.isFinite(value) && value > 0) || !Number.isFinite(closedAt) || closedAt > lastQuoteAt
    || values[2] > Math.min(values[0], values[3]) || values[1] < Math.max(values[0], values[3])
    || values[1] < values[2] || candle?.source !== source) return false;
  if (source === 'BROKER' && candle.quality !== 'VERIFIED_CLOSED') return false;
  if (source === 'SYNTHETIC' && candle.quality !== 'SYNTHETIC_FIXTURE') return false;
  return candle.tickVolume == null || (Number.isInteger(Number(candle.tickVolume)) && Number(candle.tickVolume) >= 0);
}

function validateInstrument(instrument, accountCurrency) {
  if (!instrument || !['contractSize', 'tickSize', 'tickValue', 'minLot', 'lotStep', 'maxLot'].every((key) => positive(instrument[key]))) {
    throw new TypeError('RESEARCH_INSTRUMENT_METADATA_INCOMPLETE');
  }
  if (typeof instrument.tickValueCurrency !== 'string' || !/^[A-Z]{3}$/.test(instrument.tickValueCurrency)) {
    throw new TypeError('RESEARCH_TICK_VALUE_CURRENCY_INVALID');
  }
  if (instrument.tickValueCurrency !== accountCurrency && !positive(instrument.tickValueConversionRate)) {
    throw new TypeError('RESEARCH_TICK_VALUE_CONVERSION_MISSING');
  }
  if (Number(instrument.minLot) > Number(instrument.maxLot)) throw new TypeError('RESEARCH_INSTRUMENT_LOT_RANGE_INVALID');
}

function validateDataset(dataset, { testOnlyAllowSyntheticData = false } = {}) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset) || dataset.schemaVersion !== 1) {
    throw new TypeError('RESEARCH_DATASET_SCHEMA_UNSUPPORTED');
  }
  const manifest = dataset.manifest;
  if (!manifest || typeof manifest.datasetId !== 'string' || !/^[A-Za-z0-9._:-]{8,96}$/.test(manifest.datasetId)
    || !Number.isFinite(instant(manifest.retrievedAt)) || !/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? '')) {
    throw new TypeError('RESEARCH_DATASET_MANIFEST_INVALID');
  }
  const synthetic = manifest.dataClass === 'SYNTHETIC_TEST';
  if (!synthetic && manifest.dataClass !== 'BROKER_HISTORICAL') throw new TypeError('RESEARCH_DATA_CLASS_INVALID');
  if (synthetic && !testOnlyAllowSyntheticData) throw new TypeError('SYNTHETIC_PERFORMANCE_EVALUATION_FORBIDDEN');
  const provider = synthetic ? null : assertProviderLabel(manifest.provider, 'RESEARCH_PROVIDER_LABEL_INVALID');
  if (hashResearchDataset(dataset) !== manifest.sha256.toLowerCase()) throw new TypeError('RESEARCH_DATASET_HASH_MISMATCH');
  if (dataset.symbol !== 'XAUUSD') throw new TypeError('RESEARCH_SYMBOL_UNSUPPORTED');

  const source = synthetic ? 'SYNTHETIC' : 'BROKER';
  const quotes = dataset.quotes;
  if (!Array.isArray(quotes) || quotes.length < 2 || quotes.length > MAX_QUOTES) throw new TypeError('RESEARCH_QUOTES_INVALID');
  let previousQuoteAt = -Infinity;
  let maxQuoteGapMs = 0;
  let quoteGapsOver30s = 0;
  for (const quote of quotes) {
    const observedAt = instant(quote?.observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= previousQuoteAt || quote.source !== source
      || !positive(quote.bid) || !positive(quote.ask) || Number(quote.ask) < Number(quote.bid)
      || (quote.last != null && !positive(quote.last))) throw new TypeError('RESEARCH_QUOTE_SCHEMA_OR_ORDER_INVALID');
    if (Number.isFinite(previousQuoteAt)) {
      const gapMs = observedAt - previousQuoteAt;
      maxQuoteGapMs = Math.max(maxQuoteGapMs, gapMs);
      if (gapMs > 30_000) quoteGapsOver30s += 1;
    }
    previousQuoteAt = observedAt;
  }
  const lastQuoteAt = previousQuoteAt;
  const firstQuoteAt = instant(quotes[0].observedAt);
  if (!dataset.candlesByTimeframe || typeof dataset.candlesByTimeframe !== 'object') throw new TypeError('RESEARCH_CANDLES_MISSING');
  for (const timeframe of TIMEFRAMES) {
    const candles = dataset.candlesByTimeframe[timeframe];
    if (!Array.isArray(candles) || candles.length < REQUIRED_HISTORY || candles.length > MAX_CANDLES_PER_FRAME) {
      throw new TypeError(`RESEARCH_${timeframe}_HISTORY_INVALID`);
    }
    let previousAt = -Infinity;
    for (const candle of candles) {
      const closedAt = instant(candle?.closedAt);
      if (!validateCandle(candle, source, lastQuoteAt) || closedAt <= previousAt) {
        throw new TypeError(`RESEARCH_${timeframe}_CANDLE_INVALID_OR_UNORDERED`);
      }
      previousAt = closedAt;
    }
  }
  if (!dataset.account || !positive(dataset.account.equity) || typeof dataset.account.currency !== 'string'
    || !/^[A-Z]{3}$/.test(dataset.account.currency)) throw new TypeError('RESEARCH_ACCOUNT_METADATA_INVALID');
  validateInstrument(dataset.instrument, dataset.account.currency);
  if (!dataset.paperCosts || dataset.paperCosts.accountCurrency !== dataset.account.currency) {
    throw new TypeError('RESEARCH_EXECUTION_COSTS_INVALID');
  }
  // Reuse the same adapter contract used by paper execution for all required cost fields.
  const requiredCosts = ['slippagePrice', 'commissionPerLot', 'swapPerLotPerDay', 'fillLatencyMs', 'fillRatio',
    'contractSize', 'quoteToAccountRate', 'lotStep', 'minimumLot', 'breakEvenOffsetPrice'];
  if (!requiredCosts.every((key) => finite(dataset.paperCosts[key])) || dataset.paperCosts.fillLatencyMs < 0
    || dataset.paperCosts.fillLatencyMs > 120_000 || dataset.paperCosts.slippagePrice < 0
    || dataset.paperCosts.commissionPerLot < 0 || dataset.paperCosts.swapPerLotPerDay < 0
    || dataset.paperCosts.fillRatio <= 0 || dataset.paperCosts.fillRatio > 1
    || !['contractSize', 'quoteToAccountRate', 'lotStep', 'minimumLot'].every((key) => positive(dataset.paperCosts[key]))) {
    throw new TypeError('RESEARCH_EXECUTION_COSTS_INVALID');
  }
  if (Number(dataset.paperCosts.contractSize) !== Number(dataset.instrument.contractSize)
    || Number(dataset.paperCosts.lotStep) !== Number(dataset.instrument.lotStep)
    || Number(dataset.paperCosts.minimumLot) !== Number(dataset.instrument.minLot)) {
    throw new TypeError('RESEARCH_EXECUTION_COSTS_CONTRACT_MISMATCH');
  }
  if (!positive(dataset.maxSpreadPrice)) throw new TypeError('RESEARCH_SPREAD_LIMIT_REQUIRED');
  const newsSnapshots = dataset.newsSnapshots;
  if (!Array.isArray(newsSnapshots) || !newsSnapshots.length) throw new TypeError('RESEARCH_NEWS_SNAPSHOTS_REQUIRED');
  if (newsSnapshots.length > MAX_NEWS_SNAPSHOTS) throw new TypeError('RESEARCH_NEWS_SNAPSHOT_LIMIT_EXCEEDED');
  let previousNewsAt = -Infinity;
    for (const snapshot of newsSnapshots) {
    const fetchedAt = instant(snapshot?.fetchedAt);
    if (!Number.isFinite(fetchedAt) || fetchedAt < previousNewsAt || !['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE'].includes(snapshot.status)
      || !Array.isArray(snapshot.events) || snapshot.events.length > 500) throw new TypeError('RESEARCH_NEWS_SNAPSHOT_INVALID');
    if (snapshot.events.some((event) => !event || typeof event.title !== 'string' || !event.title.trim()
      || typeof event.currency !== 'string' || !/^[A-Z]{3}$/.test(event.currency)
      || typeof event.impact !== 'string' || !Number.isFinite(instant(event.scheduledAt)))) {
      throw new TypeError('RESEARCH_NEWS_EVENT_INVALID');
    }
    previousNewsAt = fetchedAt;
  }
  if (previousNewsAt > lastQuoteAt) throw new TypeError('RESEARCH_NEWS_LOOKAHEAD_INVALID');
  return { synthetic, source, provider, quotes, firstQuoteAt, lastQuoteAt, maxQuoteGapMs, quoteGapsOver30s, newsSnapshots };
}

export function buildWalkForwardFolds(m15Candles, {
  trainingFraction = 0.7,
  foldCount = 3,
  minimumTrainingBars = REQUIRED_HISTORY,
} = {}) {
  if (!Array.isArray(m15Candles) || !Number.isInteger(foldCount) || foldCount < 1 || foldCount > 10
    || !Number.isFinite(trainingFraction) || trainingFraction <= 0 || trainingFraction >= 1
    || !Number.isInteger(minimumTrainingBars) || minimumTrainingBars < REQUIRED_HISTORY) {
    throw new TypeError('WALK_FORWARD_OPTIONS_INVALID');
  }
  const times = m15Candles.map((candle) => instant(candle?.closedAt));
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1]))) {
    throw new TypeError('WALK_FORWARD_TIMESTAMPS_INVALID');
  }
  const trainingBars = Math.max(minimumTrainingBars, Math.floor(times.length * trainingFraction));
  const testBars = times.length - trainingBars;
  if (trainingBars >= times.length || testBars < foldCount) throw new TypeError('WALK_FORWARD_HISTORY_INSUFFICIENT');
  const baseLength = Math.floor(testBars / foldCount);
  let remainder = testBars % foldCount;
  let cursor = trainingBars;
  return Array.from({ length: foldCount }, (_, index) => {
    const length = baseLength + (remainder-- > 0 ? 1 : 0);
    const startIndex = cursor;
    const endIndex = cursor + length;
    cursor = endIndex;
    return {
      fold: index + 1,
      trainingBars: startIndex,
      testStartIndex: startIndex,
      testEndIndexExclusive: endIndex,
      testBars: length,
      testStartAt: new Date(times[startIndex]).toISOString(),
      testEndAt: new Date(times[endIndex - 1]).toISOString(),
    };
  });
}

function convertedTickValue(instrument, currency) {
  return instrument.tickValueCurrency === currency ? Number(instrument.tickValue) : Number(instrument.tickValue) * Number(instrument.tickValueConversionRate);
}

function refreshRiskMetrics(db, { now, account, instrument, costs, maxSpreadPrice, peakEquity, quote }) {
  const trades = db.prepare("SELECT pnl_r, net_pnl, closed_at FROM trades WHERE accounting_status = 'VALID' ORDER BY closed_at, rowid").all();
  const closedNet = trades.reduce((sum, trade) => sum + Number(trade.net_pnl), 0);
  const openPositions = db.prepare("SELECT * FROM positions WHERE status IN ('OPEN', 'PARTIAL')").all();
  const markValue = openPositions.reduce((sum, position) => {
    const lots = Number(position.quantity_open_lots);
    const realized = Number(position.realized_pnl);
    const sidePrice = position.side === 'LONG' ? Number(quote.bid) : Number(quote.ask);
    const direction = position.side === 'LONG' ? 1 : -1;
    const unrealized = (sidePrice - Number(position.entry_price)) * direction * lots
      * Number(costs.contractSize) * Number(costs.quoteToAccountRate)
      - lots * Number(costs.commissionPerLot) - Number(position.swap_paid ?? 0);
    return sum + realized + unrealized;
  }, 0);
  const equity = Number((Number(account.equity) + closedNet + markValue).toFixed(2));
  const highWater = Math.max(peakEquity, equity);
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater * 100) : 100;
  const utcDate = now.toISOString().slice(0, 10);
  const closedDailyLossR = trades.filter((trade) => trade.closed_at.slice(0, 10) === utcDate)
    .reduce((sum, trade) => sum + Math.max(0, -Number(trade.pnl_r ?? 0)), 0);
  const openDailyLossR = openPositions.filter((position) => position.opened_at.slice(0, 10) === utcDate)
    .reduce((sum, position) => {
      const initialRisk = Number(position.initial_risk_amount);
      const lots = Number(position.quantity_open_lots);
      const sidePrice = position.side === 'LONG' ? Number(quote.bid) : Number(quote.ask);
      const direction = position.side === 'LONG' ? 1 : -1;
      const netMark = Number(position.realized_pnl)
        + (sidePrice - Number(position.entry_price)) * direction * lots * Number(costs.contractSize) * Number(costs.quoteToAccountRate)
        - lots * Number(costs.commissionPerLot) - Number(position.swap_paid ?? 0);
      return sum + (initialRisk > 0 ? Math.max(0, -netMark / initialRisk) : 0);
    }, 0);
  const tickValue = convertedTickValue(instrument, account.currency);
  const positionRisk = openPositions.reduce((sum, position) => {
    const stopDistance = Math.abs(Number(position.entry_price) - Number(position.stop_price));
    return sum + stopDistance / Number(instrument.tickSize) * tickValue * Number(position.quantity_open_lots);
  }, 0);
  const pendingRisk = db.prepare("SELECT quantity_lots, remaining_quantity_lots, entry_price, stop_price, snapshot_json FROM orders WHERE status IN ('PENDING', 'PARTIAL')").all()
    .reduce((sum, order) => {
      const snapshot = JSON.parse(order.snapshot_json);
      const requested = Number(order.quantity_lots);
      const remaining = Number(order.remaining_quantity_lots);
      const amount = Number(snapshot.sizing?.riskAmount ?? 0);
      return sum + (requested > 0 ? amount * remaining / requested : 0);
    }, 0);
  const riskMetrics = {
    equity,
    currency: account.currency,
    dailyLossR: Number((closedDailyLossR + openDailyLossR).toFixed(6)),
    drawdownPct: Number(drawdownPct.toFixed(6)),
    openRiskPct: equity > 0 ? Number(((positionRisk + pendingRisk) / equity * 100).toFixed(6)) : null,
    maxSpreadPrice,
  };
  writeState(db, 'riskMetrics', riskMetrics, now.toISOString());
  return { ...riskMetrics, peakEquity: highWater };
}

function safeDecision(row, synthetic) {
  const decision = JSON.parse(row.decision_snapshot_json ?? '{}');
  const snapshots = decision.snapshots ?? {};
  const researchNews = snapshots.news ?? {};
  const nextEvent = researchNews.nextEvent;
  return {
    at: row.started_at,
    status: row.status,
    direction: row.direction,
    score: row.score,
    confluencePct: row.confluence_pct,
    reasons: JSON.parse(row.reason_json),
    snapshot: {
      gate: decision.gate ?? null,
      plan: decision.plan ?? null,
      sizing: decision.sizing ?? null,
      analyses: (snapshots.decision?.analyses ?? []).map((item) => ({
        timeframe: item.timeframe,
        direction: item.direction,
        strength: item.strength,
        votes: item.votes,
        indicators: item.indicators,
        candleClosedAt: item.candleClosedAt,
        rejectionReasons: item.rejectionReasons,
      })),
      news: {
        allowed: researchNews.allowed ?? false,
        inBlackout: researchNews.inBlackout ?? true,
        reasons: researchNews.reasons ?? [],
        nextEvent: nextEvent ? {
          currency: nextEvent.currency ?? null,
          impact: nextEvent.impact ?? null,
          scheduledAt: nextEvent.scheduledAt ?? null,
          category: nextEvent.category ?? null,
        } : null,
      },
      market: {
        source: synthetic ? 'SYNTHETIC_FIXTURE' : snapshots.market?.source ?? null,
        quote: snapshots.market?.quote ? {
          bid: snapshots.market.quote.bid,
          ask: snapshots.market.quote.ask,
          observedAt: snapshots.market.quote.observedAt,
        } : null,
        session: snapshots.decision?.session?.active ?? [],
      },
      risk: snapshots.risk ?? null,
      account: snapshots.account ?? null,
      instrument: snapshots.instrument ?? null,
      config: snapshots.config ?? null,
    },
  };
}

function safeTrade(row, synthetic) {
  const snapshot = JSON.parse(row.snapshot_json ?? '{}');
  const artifact = {
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    side: row.side,
    closeReason: row.close_reason,
    durationSeconds: row.duration_seconds,
    entryDelaySeconds: row.entry_delay_seconds,
    setupQuality: row.setup_quality?.split('|').filter(Boolean) ?? [],
    marketCondition: row.market_condition?.split('|').filter(Boolean) ?? [],
    classification: synthetic ? null : snapshot.classification ?? null,
    fills: (snapshot.fills ?? []).map((fill) => ({
      at: fill.at, status: fill.status, reason: fill.reason, filledLots: fill.filledLots,
      fillPrice: fill.fillPrice, quoteObservedAt: fill.quoteObservedAt, fillLatencyMs: fill.fillLatencyMs,
    })),
    executionCosts: snapshot.executionCosts ?? null,
    exit: snapshot.exit ? { price: snapshot.exit.price, reason: snapshot.exit.reason, costs: snapshot.exit.costs } : null,
  };
  if (!synthetic) Object.assign(artifact, {
    grossPnl: Number(row.gross_pnl), netPnl: Number(row.net_pnl), pnlR: row.pnl_r,
    commission: Number(row.commission), swap: Number(row.swap), mfe: Number(row.mfe), mae: Number(row.mae),
  });
  return artifact;
}

async function evaluateFold(dataset, validated, fold) {
  const db = openDatabase(':memory:', MIGRATIONS);
  const firstQuoteAt = instant(validated.quotes[0].observedAt);
  initializeDatabase(db, new Date(firstQuoteAt));
  writeState(db, 'paperMode', true, new Date(firstQuoteAt).toISOString());
  writeState(db, 'entryPaused', true, new Date(firstQuoteAt).toISOString());
  writeState(db, 'instrumentMetadata', dataset.instrument, new Date(firstQuoteAt).toISOString());
  writeState(db, 'paperCosts', dataset.paperCosts, new Date(firstQuoteAt).toISOString());
  writeState(db, 'riskMetrics', {
    equity: dataset.account.equity, currency: dataset.account.currency, dailyLossR: 0,
    drawdownPct: 0, openRiskPct: 0, maxSpreadPrice: dataset.maxSpreadPrice,
  }, new Date(firstQuoteAt).toISOString());

  let currentQuote = null;
  const candleReplay = Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, {
    candles: dataset.candlesByTimeframe[timeframe],
    times: dataset.candlesByTimeframe[timeframe].map((candle) => instant(candle.closedAt)),
    cursor: 0,
  }]));
  const newsTimes = validated.newsSnapshots.map((snapshot) => instant(snapshot.fetchedAt));
  let newsCursor = -1;
  const provider = {
    async readHealth(now) { return { source: 'HistoricalFeed', status: 'HEALTHY', checkedAt: now.toISOString() }; },
    async readMarketData(now) {
      const observedAt = instant(currentQuote.observedAt);
      const candlesByTimeframe = {};
      for (const timeframe of TIMEFRAMES) {
        const replay = candleReplay[timeframe];
        const start = replay.cursor;
        while (replay.cursor < replay.candles.length && replay.times[replay.cursor] <= observedAt) replay.cursor += 1;
        candlesByTimeframe[timeframe] = replay.candles.slice(start, replay.cursor).map((candle) => ({
          ...candle,
          source: 'BROKER',
          quality: 'VERIFIED_CLOSED',
        }));
      }
      return {
        source: 'BROKER',
        quote: {
          symbol: 'XAUUSD', source: 'BROKER', bid: currentQuote.bid, ask: currentQuote.ask,
          last: currentQuote.last ?? (Number(currentQuote.bid) + Number(currentQuote.ask)) / 2,
          observedAt: currentQuote.observedAt,
        },
        candlesByTimeframe,
      };
    },
  };
  const newsProvider = {
    async readCalendar(now) {
      const currentAt = now.getTime();
      while (newsCursor + 1 < validated.newsSnapshots.length && newsTimes[newsCursor + 1] <= currentAt) newsCursor += 1;
      const selected = newsCursor >= 0 ? validated.newsSnapshots[newsCursor] : null;
      return selected ? {
        source: 'HistoricalNews', status: selected.status, fetchedAt: selected.fetchedAt,
        events: selected.events.map((event) => ({ ...event })),
        reason: selected.status === 'HEALTHY' ? null : 'NEWS_SOURCE_UNAVAILABLE',
      } : { source: 'HistoricalNews', status: 'OFFLINE', fetchedAt: null, events: [], reason: 'NEWS_SOURCE_UNAVAILABLE' };
    },
  };
  const worker = new PaperWorker({ db, provider, newsProvider, clock: () => new Date(instant(currentQuote.observedAt)) });
  let peakEquity = Number(dataset.account.equity);
  const quoteEvents = [];
  let attemptedScans = 0;
  let testQuoteCount = 0;
  try {
    for (const quote of validated.quotes) {
      const at = instant(quote.observedAt);
      if (at > instant(fold.testEndAt)) break;
      currentQuote = quote;
      if (at >= instant(fold.testStartAt)) testQuoteCount += 1;
      const now = new Date(at);
      writeState(db, 'entryPaused', at < instant(fold.testStartAt), now.toISOString());
      const risk = refreshRiskMetrics(db, {
        now, account: dataset.account, instrument: dataset.instrument,
        costs: dataset.paperCosts, maxSpreadPrice: dataset.maxSpreadPrice, peakEquity, quote,
      });
      peakEquity = risk.peakEquity;
      const tick = await worker.tick();
      if (tick.error) {
        throw new Error('RESEARCH_WORKER_TICK_FAILED');
      }
      if (tick.scan && at >= instant(fold.testStartAt)) {
        const row = db.prepare(`
          SELECT started_at, status, direction, score, confluence_pct, reason_json, decision_snapshot_json
          FROM scan_runs ORDER BY rowid DESC LIMIT 1
        `).get();
        if (row && quoteEvents.length < MAX_REPORTED_ARTIFACTS_PER_FOLD) quoteEvents.push(safeDecision(row, validated.synthetic));
        attemptedScans += 1;
      }
    }
    const trades = db.prepare("SELECT * FROM trades WHERE accounting_status = 'VALID' AND closed_at >= ? AND closed_at <= ? ORDER BY closed_at, rowid")
      .all(fold.testStartAt, fold.testEndAt);
    const statisticRows = trades.map((trade) => {
      const snapshot = JSON.parse(trade.snapshot_json ?? '{}');
      const position = db.prepare('SELECT tp1_hit FROM positions WHERE id = ?').get(trade.position_id);
      return {
        netPnl: Number(trade.net_pnl), pnlR: trade.pnl_r, grossPnl: Number(trade.gross_pnl),
        commission: Number(trade.commission), swap: Number(trade.swap), currency: dataset.account.currency,
        entryDelaySeconds: trade.entry_delay_seconds, durationSeconds: trade.duration_seconds,
        mfe: Number(trade.mfe), mae: Number(trade.mae), tp1Hit: Boolean(position?.tp1_hit),
        closeReason: trade.close_reason, side: trade.side,
        setupQuality: trade.setup_quality?.split('|').filter(Boolean) ?? [],
        marketConditions: trade.market_condition?.split('|').filter(Boolean) ?? [],
        spreadAtrRatio: snapshot.classification?.spreadAtrRatio,
        broker: 'BROKER', symbol: 'XAUUSD', timeframe: 'M15', closedAt: trade.closed_at,
      };
    });
    const pendingExpiredCount = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'EXPIRED'").get().count;
    const statistics = aggregateTradeStatistics(statisticRows, {
      now: new Date(instant(fold.testEndAt)), pendingExpiredCount,
    });
    const remaining = {
      openPositions: db.prepare("SELECT COUNT(*) AS count FROM positions WHERE status IN ('OPEN', 'PARTIAL')").get().count,
      pendingOrders: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('PENDING', 'PARTIAL')").get().count,
      expiredOrders: pendingExpiredCount,
    };
    const closedTradeArtifacts = trades.slice(0, MAX_REPORTED_ARTIFACTS_PER_FOLD)
      .map((trade) => safeTrade(trade, validated.synthetic));
    const scanCoveragePct = fold.testBars > 0 ? Number((Math.min(100, attemptedScans / fold.testBars * 100)).toFixed(2)) : 0;
    const completeScanCoverage = scanCoveragePct === 100 && testQuoteCount > 0;
    const measuredMetrics = validated.synthetic || !completeScanCoverage ? null : statistics.metrics;
    return {
      ...fold,
      scans: attemptedScans,
      testQuoteCount,
      expectedTestM15Bars: fold.testBars,
      scanCoveragePct,
      decisions: quoteEvents,
      decisionsTruncated: attemptedScans > quoteEvents.length,
      closedTradeCount: trades.length,
      tradeArtifacts: closedTradeArtifacts,
      tradeArtifactsTruncated: trades.length > closedTradeArtifacts.length,
      performance: {
        sampleCount: trades.length,
        metrics: measuredMetrics,
        suppressedReason: validated.synthetic ? 'SYNTHETIC_SOFTWARE_TEST_ONLY'
          : !completeScanCoverage ? 'M15_SCAN_COVERAGE_INCOMPLETE'
            : statistics.sufficientSample ? statistics.metricsSuppressedReason : 'SAMPLE_BELOW_30',
        cohorts: validated.synthetic || !completeScanCoverage ? null : statistics.slices,
      },
      remaining,
    };
  } finally {
    worker.stop();
    db.close();
  }
}

export async function runWalkForwardEvaluation(dataset, options = {}) {
  const validated = validateDataset(dataset, options);
  const folds = buildWalkForwardFolds(dataset.candlesByTimeframe.M15, {
    trainingFraction: options.trainingFraction ?? 0.7,
    foldCount: options.foldCount ?? 3,
    minimumTrainingBars: options.minimumTrainingBars ?? REQUIRED_HISTORY,
  });
  const foldResults = [];
  for (const fold of folds) foldResults.push(await evaluateFold(dataset, validated, fold));
  const identity = {
    datasetSha256: dataset.manifest.sha256.toLowerCase(),
    strategyVersion: config.strategyVersion,
    buildId: config.buildId,
    schemaVersion: config.schemaVersion,
    foldOptions: {
      trainingFraction: options.trainingFraction ?? 0.7,
      foldCount: options.foldCount ?? 3,
      minimumTrainingBars: options.minimumTrainingBars ?? REQUIRED_HISTORY,
    },
    maxSpreadPrice: dataset.maxSpreadPrice,
    executionCosts: dataset.paperCosts,
  };
  const report = {
    schemaVersion: 1,
    runId: hashPayload(identity),
    evidenceClass: validated.synthetic ? 'SYNTHETIC_SOFTWARE_TEST_ONLY' : 'OWNER_ATTESTED_HISTORICAL_REPLAY',
    performanceEvidenceEligible: !validated.synthetic && foldResults.every((fold) => fold.scanCoveragePct === 100),
    profitabilityClaim: false,
    liveTradingEnabled: false,
    buildId: config.buildId,
    provenance: {
      datasetId: dataset.manifest.datasetId,
      dataClass: dataset.manifest.dataClass,
      sourceAttestation: validated.synthetic ? 'SYNTHETIC_FIXTURE' : 'OWNER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED',
      datasetSha256: dataset.manifest.sha256.toLowerCase(),
      provider: validated.provider,
      quoteCount: dataset.quotes.length,
      firstQuoteAt: new Date(validated.firstQuoteAt).toISOString(),
      lastQuoteAt: new Date(validated.lastQuoteAt).toISOString(),
      quoteCoverage: {
        maximumObservedGapMs: validated.maxQuoteGapMs,
        gapsOver30Seconds: validated.quoteGapsOver30s,
        warning: validated.quoteGapsOver30s ? 'QUOTE_GAPS_OVER_RUNTIME_FRESHNESS_LIMIT_REQUIRE_REVIEW' : null,
      },
      candleCounts: Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, dataset.candlesByTimeframe[timeframe].length])),
      newsSnapshotCount: dataset.newsSnapshots.length,
    },
    strategyVersion: config.strategyVersion,
    schemaVersionUsed: config.schemaVersion,
    methodology: {
      description: 'Chronological expanding-history paper replay. Training bars warm indicators with entries paused; this harness does not fit or optimize strategy parameters.',
      execution: 'The production local PaperWorker and paper lifecycle process supplied bid/ask observations with the declared paper-cost assumptions.',
      closedTradesOnly: true,
      positionsOpenAtFoldEnd: 'Reported as remaining exposure and excluded from closed-trade performance metrics.',
      limitations: [
        'Historical provider authenticity and account/contract metadata are owner asserted, not independently verified.',
        'The replay does not reconstruct order-book depth, queue position, or broker-specific execution behavior.',
        'Historical replay results do not establish future profitability.',
      ],
    },
    foldOptions: identity.foldOptions,
    maxSpreadPrice: dataset.maxSpreadPrice,
    executionCosts: dataset.paperCosts,
    folds: foldResults,
  };
  return { ...report, reportSha256: hashPayload(report) };
}
