import { randomUUID } from 'node:crypto';
import { appendAudit, readState } from '../database.mjs';
import { config as baseConfig, fingerprintConfiguration } from '../config.mjs';
import { evaluateNewsBlackout } from '../domain/news.mjs';
import { evaluatePaperScan } from '../domain/paper-engine.mjs';
import { activeSessions } from '../domain/market-sessions.mjs';
import { loadFreshRiskMetrics } from './risk-state-service.mjs';

function httpRequestAuditMetadata(httpRequestId) {
  return typeof httpRequestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(httpRequestId)
    ? { httpRequestId }
    : {};
}

function asJson(value, fallback = {}) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function loadScanContext(db, now = new Date()) {
  const latest = db.prepare(`
    SELECT symbol, source, status, bid, ask, last, observed_at, received_at, details_json
    FROM market_snapshots ORDER BY received_at DESC LIMIT 1
  `).get();
  const receivedAt = latest?.received_at ? Date.parse(latest.received_at) : NaN;
  const observedAt = latest?.observed_at ? Date.parse(latest.observed_at) : NaN;
  const receivedAgeMs = Number.isFinite(receivedAt) ? now.getTime() - receivedAt : Number.POSITIVE_INFINITY;
  const observedAgeMs = Number.isFinite(observedAt) ? now.getTime() - observedAt : Number.POSITIVE_INFINITY;
  const marketFresh = latest?.source === 'BROKER' && latest.status === 'BROKER'
    && receivedAgeMs >= 0 && receivedAgeMs <= 30_000 && observedAgeMs >= 0 && observedAgeMs <= 30_000;
  const market = {
    source: latest?.source ?? 'none',
    dataFreshness: marketFresh ? 'FRESH' : latest ? 'STALE' : 'UNAVAILABLE',
    status: latest?.status ?? 'UNAVAILABLE',
    quote: latest && latest.bid != null && latest.ask != null ? {
      bid: latest.bid,
      ask: latest.ask,
      last: latest.last,
      observedAt: latest.observed_at,
      receivedAt: latest.received_at,
      reason: asJson(latest.details_json).reason ?? null,
    } : null,
    session: activeSessions(now),
  };

  const candlesByTimeframe = {};
  for (const timeframe of ['H4', 'H1', 'M30', 'M15']) {
    candlesByTimeframe[timeframe] = db.prepare(`
      SELECT open_price AS open, high_price AS high, low_price AS low, close_price AS close,
        tick_volume AS tickVolume, closed_at AS closedAt, source, quality
      FROM candles WHERE symbol = 'XAUUSD' AND timeframe = ? ORDER BY closed_at DESC LIMIT 100
    `).all(timeframe).reverse();
  }

  const newsProvider = readState(db, 'newsProvider', { status: 'OFFLINE', fetchedAt: null });
  const events = db.prepare(`
    SELECT title, currency, impact, scheduled_at, source, fetched_at, details_json
    FROM news_events WHERE scheduled_at >= ? ORDER BY scheduled_at LIMIT 200
  `).all(new Date(now.getTime() - 60 * 60_000).toISOString()).map((event) => ({
    title: event.title,
    currency: event.currency,
    impact: event.impact,
    scheduledAt: event.scheduled_at,
    category: asJson(event.details_json).category,
  }));
  const newsState = evaluateNewsBlackout({
    events,
    fetchedAt: newsProvider.fetchedAt,
    sourceStatus: newsProvider.status,
    now,
    beforeMinutes: baseConfig.risk.newsBlackoutBeforeMinutes,
    afterMinutes: baseConfig.risk.newsBlackoutAfterMinutes,
  });

  const riskState = loadFreshRiskMetrics(db, now);
  const instrument = readState(db, 'instrumentMetadata', null);
  const paperCosts = readState(db, 'paperCosts', null);
  const account = riskState.freshness === 'FRESH'
    ? { equity: riskState.equity, currency: riskState.currency }
    : null;
  const riskConfig = {
    ...baseConfig.risk,
    maxSpreadPrice: riskState.freshness === 'FRESH' ? riskState.maxSpreadPrice ?? null : null,
  };
  const versionManifest = {
    profileId: baseConfig.strategyProfileId,
    baseVersion: baseConfig.strategyVersion,
    risk: riskConfig,
    strategyParameters: baseConfig.strategyParameters,
    parameterRationale: baseConfig.parameterRationale,
  };
  const configVersion = fingerprintConfiguration(versionManifest, baseConfig.strategyProfileId);
  const config = {
    ...riskConfig,
    profileId: baseConfig.strategyProfileId,
    baseVersion: baseConfig.strategyVersion,
    strategyParameters: baseConfig.strategyParameters,
    parameterRationale: baseConfig.parameterRationale,
    versionManifest,
    version: configVersion,
  };
  return {
    market,
    candlesByTimeframe,
    newsState,
    riskState,
    account,
    instrument,
    paperCosts,
    config,
    entryPaused: readState(db, 'entryPaused', true),
    paperMode: readState(db, 'paperMode', true),
    now,
  };
}

export function persistScanResult(db, result, { logicalKey, now = new Date(), transactional = true, httpRequestId = null }) {
  if (typeof logicalKey !== 'string' || logicalKey.length < 8 || logicalKey.length > 200) throw new TypeError('A bounded logical scan key is required.');
  const existing = db.prepare(`SELECT id, status, reason_json FROM scan_runs WHERE idempotency_key = ?`).get(logicalKey);
  if (existing) return { scanId: existing.id, status: existing.status, reasons: asJson(existing.reason_json, []), replayed: true, accepted: existing.status === 'ORDER_STAGED' };

  const id = randomUUID();
  const correlationId = randomUUID();
  const configVersion = result.snapshots?.configVersion ?? baseConfig.strategyVersion;
  if (transactional) db.exec('BEGIN IMMEDIATE');
  try {
    const raced = db.prepare(`SELECT id, status, reason_json FROM scan_runs WHERE idempotency_key = ?`).get(logicalKey);
    if (raced) {
      if (transactional) db.exec('COMMIT');
      return { scanId: raced.id, status: raced.status, reasons: asJson(raced.reason_json, []), replayed: true, accepted: raced.status === 'ORDER_STAGED' };
    }

    const effectiveConfig = result.snapshots?.config;
    if (effectiveConfig && typeof effectiveConfig === 'object') {
      db.prepare(`
        INSERT OR IGNORE INTO config_versions (version, config_json, rationale, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        configVersion,
        JSON.stringify(effectiveConfig),
        'Immutable effective paper strategy, risk limits, provider spread threshold, and parameter rationale used by this scan.',
        now.toISOString(),
      );
    }

    let finalStatus = result.status;
    let finalReasons = [...(result.reasons ?? [])];
    let accepted = result.accepted === true;
    const m15CandleClose = result.analyses?.find((item) => item.timeframe === 'M15')?.candleClosedAt ?? logicalKey;
    const logicalOrderKey = accepted
      ? `XAUUSD:M15:${m15CandleClose}:${result.direction}`
      : null;
    if (accepted) {
      const side = result.direction === 'LONG' ? 'BUY' : 'SELL';
      const duplicateLogicalSetup = db.prepare(`
        SELECT id FROM signals WHERE logical_setup_key = ? LIMIT 1
      `).get(logicalOrderKey);
      const duplicateOrder = db.prepare(`
        SELECT id FROM orders WHERE symbol = 'XAUUSD' AND side = ? AND status IN ('PENDING', 'PARTIAL') LIMIT 1
      `).get(side);
      const duplicatePosition = db.prepare(`
        SELECT id FROM positions WHERE symbol = 'XAUUSD' AND side = ? AND status IN ('OPEN', 'PARTIAL') LIMIT 1
      `).get(result.direction);
      if (duplicateLogicalSetup || duplicateOrder || duplicatePosition) {
        accepted = false;
        finalStatus = 'REJECTED';
        finalReasons = [...new Set([...finalReasons, 'DUPLICATE_LOGICAL_SETUP'])];
      }
    }

    db.prepare(`
      INSERT INTO scan_runs (id, idempotency_key, symbol, started_at, completed_at, status, reason_json, config_version, correlation_id)
      VALUES (?, ?, 'XAUUSD', ?, ?, ?, ?, ?, ?)
    `).run(id, logicalKey, now.toISOString(), now.toISOString(), accepted ? 'ORDER_STAGED' : finalStatus, JSON.stringify(finalReasons), configVersion, correlationId);

    db.prepare(`
      UPDATE scan_runs SET direction = ?, score = ?, confluence_pct = ?, decision_snapshot_json = ? WHERE id = ?
    `).run(
      result.direction ?? null,
      Number.isFinite(Number(result.score)) ? Number(result.score) : null,
      Number.isFinite(Number(result.confluencePct)) ? Number(result.confluencePct) : null,
      JSON.stringify({
        direction: result.direction ?? null,
        score: result.score ?? null,
        confluencePct: result.confluencePct ?? null,
        gate: result.gate ?? null,
        plan: result.plan ?? null,
        sizing: result.sizing ?? null,
        snapshots: result.snapshots ?? null,
      }),
      id,
    );

    const saveTimeframe = db.prepare(`
      INSERT INTO timeframe_analyses (id, scan_id, timeframe, direction, strength, votes_json, indicators_json, rejection_reasons_json, candle_closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const analysis of result.analyses ?? []) {
      saveTimeframe.run(
        randomUUID(), id, analysis.timeframe, analysis.direction, analysis.strength,
        JSON.stringify(analysis.votes ?? []), JSON.stringify(analysis.indicators ?? null),
        JSON.stringify(analysis.rejectionReasons ?? []), analysis.candleClosedAt ?? null,
      );
    }

    db.prepare(`
      INSERT INTO risk_decisions (id, scan_id, allowed, reasons_json, inputs_json, config_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), id, accepted ? 1 : 0, JSON.stringify(finalReasons),
      JSON.stringify({ risk: result.snapshots?.risk ?? null, account: result.snapshots?.account ?? null, sizing: accepted ? result.sizing : null }),
      configVersion, now.toISOString(),
    );

    appendAudit(db, {
      actor: 'paper-worker',
      eventType: accepted ? 'PAPER_ORDER_INTENT_AUDITED' : 'PAPER_SCAN_REJECTED',
      correlationId,
      entityType: 'scan',
      entityId: id,
      reason: accepted ? 'Order intent audit written before the local paper order record.' : 'Scan was rejected or held; no order side effect was created.',
      configVersion,
      metadata: { reasons: finalReasons, source: result.snapshots?.market?.source ?? 'none', ...httpRequestAuditMetadata(httpRequestId) },
    }, now.toISOString());

    if (accepted) {
      const signalId = randomUUID();
      const orderId = randomUUID();
      const direction = result.direction;
      const plan = result.plan;
      const sizing = result.sizing;
      const executionSnapshot = {
        ...result.snapshots,
        scanId: id,
        correlationId,
        plan,
        sizing,
        direction,
        score: result.score,
      };
      db.prepare(`
        INSERT INTO signals (id, scan_id, logical_setup_key, direction, status, entry_price, stop_price, take_profit_1, take_profit_2, score, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signalId, id, logicalOrderKey, direction, String(plan.entry), String(plan.stop), String(plan.takeProfit1), String(plan.takeProfit2),
        result.score, JSON.stringify(executionSnapshot), now.toISOString(),
      );
      db.prepare(`
      INSERT INTO orders (id, idempotency_key, signal_id, symbol, side, order_type, status, quantity_lots, remaining_quantity_lots, entry_price, stop_price,
          take_profit_1, take_profit_2, expires_at, created_at, updated_at, snapshot_json)
        VALUES (?, ?, ?, 'XAUUSD', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId, logicalOrderKey, signalId, direction === 'LONG' ? 'BUY' : 'SELL', plan.orderType,
        String(sizing.lots), String(sizing.lots), String(plan.entry), String(plan.stop), String(plan.takeProfit1), String(plan.takeProfit2),
        new Date(now.getTime() + Number(plan.expiresAfterMinutes ?? 120) * 60_000).toISOString(),
        now.toISOString(), now.toISOString(), JSON.stringify(executionSnapshot),
      );
      appendAudit(db, {
        actor: 'paper-worker', eventType: 'PAPER_ORDER_STAGED', correlationId,
        entityType: 'order', entityId: orderId, reason: 'Paper order staged with a persisted logical key; no live adapter exists.',
        configVersion, metadata: { signalId, logicalOrderKey, direction, quantityLots: sizing.lots, ...httpRequestAuditMetadata(httpRequestId) },
      }, now.toISOString());
    }

    if (transactional) db.exec('COMMIT');
    return { scanId: id, status: accepted ? 'ORDER_STAGED' : finalStatus, reasons: finalReasons, replayed: false, accepted };
  } catch (error) {
    if (transactional) db.exec('ROLLBACK');
    throw error;
  }
}

export function executePaperScan(db, now = new Date(), { transactional = true, httpRequestId = null } = {}) {
  const context = loadScanContext(db, now);
  const result = evaluatePaperScan(context);
  const m15Close = context.candlesByTimeframe.M15.at(-1)?.closedAt ?? 'UNAVAILABLE';
  const logicalKey = `XAUUSD:M15:${m15Close}`;
  return { result, persisted: persistScanResult(db, result, { logicalKey, now, transactional, httpRequestId }) };
}
