import { randomUUID } from 'node:crypto';
import { appendAudit, readState, writeState } from '../database.mjs';
import { config as baseConfig } from '../config.mjs';
import { managePaperPosition, PaperBrokerAdapter } from '../domain/paper-execution.mjs';
import { evaluateRiskGuard } from '../domain/risk.mjs';
import { loadFreshRiskMetrics } from './risk-state-service.mjs';
import { isAcceptedMarketSource } from '../market-source.mjs';

const PAPER_EXECUTION_QUOTE_MAX_AGE_MS = 30_000;

const n = (value, fallback = 0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const money = (value) => Number(Number(value).toFixed(2));
const text = (value) => String(Number(value).toFixed(8));

function json(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}

function validCorrelationId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function httpRequestAuditMetadata(httpRequestId) {
  return typeof httpRequestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(httpRequestId)
    ? { httpRequestId }
    : {};
}

function correlationForOrder(db, order, snapshot = json(order.snapshot_json)) {
  if (validCorrelationId(snapshot.correlationId)) return snapshot.correlationId;
  const scan = db.prepare(`
    SELECT scan.correlation_id
    FROM signals AS signal JOIN scan_runs AS scan ON scan.id = signal.scan_id
    WHERE signal.id = ?
  `).get(order.signal_id);
  if (validCorrelationId(scan?.correlation_id)) return scan.correlation_id;
  return `legacy-order-${String(order.id).replace(/[^A-Za-z0-9._:-]/g, '_')}`.slice(0, 128);
}

function correlationForPosition(db, position, snapshot = json(position.snapshot_json)) {
  if (validCorrelationId(snapshot.correlationId)) return snapshot.correlationId;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(position.order_id);
  return order ? correlationForOrder(db, order) : `legacy-position-${String(position.id).replace(/[^A-Za-z0-9._:-]/g, '_')}`.slice(0, 128);
}

function quoteIsFreshMarketData(quote, now) {
  const observedAt = Date.parse(quote?.observedAt ?? '');
  const receivedAt = Date.parse(quote?.receivedAt ?? '');
  return isAcceptedMarketSource(quote?.source) && quote?.dataFreshness === 'FRESH'
    && Number.isFinite(observedAt) && Number.isFinite(receivedAt)
    // A dashboard may retain a provider quote for bounded observation, but a
    // paper fill still requires a quote received within the execution window.
    && now.getTime() >= observedAt && now.getTime() - observedAt <= PAPER_EXECUTION_QUOTE_MAX_AGE_MS
    && now.getTime() >= receivedAt && now.getTime() - receivedAt <= PAPER_EXECUTION_QUOTE_MAX_AGE_MS
    && n(quote.bid, NaN) > 0 && n(quote.ask, NaN) >= n(quote.bid, Infinity);
}

function usableCosts(candidate) {
  if (!candidate || typeof candidate.accountCurrency !== 'string' || !candidate.accountCurrency.trim()) return null;
  try { return new PaperBrokerAdapter({ costs: candidate }).costs; } catch { return null; }
}

function addLedger(db, { positionId, entryType, amount, currency, details, now }) {
  db.prepare(`
    INSERT INTO ledger_entries (id, position_id, entry_type, amount, currency, occurred_at, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), positionId, entryType, text(amount), currency, now.toISOString(), JSON.stringify(details ?? {}));
}

function expireOrder(db, order, now, reason = 'PENDING_EXPIRED') {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`SELECT * FROM orders WHERE id = ? AND status IN ('PENDING', 'PARTIAL')`).get(order.id);
    if (!current) { db.exec('COMMIT'); return false; }
    const signalStatus = db.prepare('SELECT status FROM signals WHERE id = ?').get(current.signal_id)?.status;
    const snapshot = json(current.snapshot_json);
    const correlationId = correlationForOrder(db, current, snapshot);
    appendAudit(db, {
      actor: 'paper-worker', eventType: reason === 'PENDING_EXPIRED' ? 'PAPER_ORDER_EXPIRED' : 'PAPER_ORDER_REMAINDER_CANCELLED',
      correlationId,
      configVersion: snapshot.configVersion ?? 'mtf-paper-v1',
      entityType: 'order', entityId: current.id,
      reason: reason === 'PENDING_EXPIRED' ? 'Paper pending order expired without a live broker side effect.' : 'Unfilled paper remainder cancelled after position management advanced.',
      metadata: { remainingLots: current.remaining_quantity_lots, reason },
    }, now.toISOString());
    db.prepare(`UPDATE orders SET status = ?, remaining_quantity_lots = '0', updated_at = ? WHERE id = ?`)
      .run(reason === 'PENDING_EXPIRED' ? 'EXPIRED' : 'CANCELLED', now.toISOString(), current.id);
    if (signalStatus === 'PENDING') {
      db.prepare('UPDATE signals SET status = ? WHERE id = ?').run('EXPIRED', current.signal_id);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cancelOrderForPaperOff(db, initial, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('PENDING', 'PARTIAL')").get(initial.id);
    if (!order) { db.exec('COMMIT'); return false; }
    const position = db.prepare("SELECT id FROM positions WHERE order_id = ? AND status IN ('OPEN', 'PARTIAL')").get(order.id);
    const snapshot = json(order.snapshot_json);
    const correlationId = correlationForOrder(db, order, snapshot);
    appendAudit(db, {
      actor: 'paper-worker', eventType: 'PAPER_ORDER_CANCELLED', correlationId,
      configVersion: snapshot.configVersion ?? 'mtf-paper-v1', entityType: 'order', entityId: order.id,
      reason: 'Paper execution mode is off; unfilled paper quantity was cancelled without affecting open-position monitoring.',
      metadata: { remainingLots: order.remaining_quantity_lots, paperMode: false, openPositionId: position?.id ?? null },
    }, now.toISOString());
    db.prepare("UPDATE orders SET status = 'CANCELLED', remaining_quantity_lots = '0', updated_at = ? WHERE id = ?")
      .run(now.toISOString(), order.id);
    if (!position) {
      db.prepare("UPDATE signals SET status = 'CANCELLED' WHERE id = ? AND status IN ('PENDING', 'PARTIAL')")
        .run(order.signal_id);
    }
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function classifyTrade(snapshot, closeReason, netTotal) {
  const context = snapshot.snapshots ?? snapshot;
  const decision = context.decision ?? snapshot.decision ?? {};
  const gate = decision.gate ?? {};
  const analyses = Array.isArray(decision.analyses) ? decision.analyses : [];
  const configuration = context.config ?? snapshot.config ?? {};
  const aligned = n(decision.alignedTimeframes ?? gate.alignedTimeframes, NaN);
  const score = n(decision.score ?? snapshot.score, NaN);
  const confluence = n(decision.confluencePct ?? gate.confluencePct, NaN);
  const rewardRisk = n(snapshot.plan?.riskReward, NaN);
  const setupQuality = [];
  if (Number.isFinite(aligned)) setupQuality.push(`MTF_${aligned}_OF_4`);
  if (Number.isFinite(score)) setupQuality.push(score >= n(configuration.minSignalScore, 70) ? 'SCORE_PASS' : 'SCORE_BELOW_GATE');
  if (Number.isFinite(confluence)) setupQuality.push(confluence >= n(configuration.minConfluencePct, 60) ? 'CONFLUENCE_PASS' : 'CONFLUENCE_BELOW_GATE');
  if (Number.isFinite(rewardRisk)) setupQuality.push(rewardRisk >= n(configuration.minRiskReward, 2) ? 'RR_PASS' : 'RR_BELOW_GATE');
  const news = context.news ?? snapshot.news ?? {};
  setupQuality.push(news.allowed === true ? 'NEWS_CLEAR' : 'NEWS_STATE_UNKNOWN');
  const marketConditions = [];
  const h1 = analyses.find((item) => item.timeframe === 'H1');
  const adx = n(h1?.indicators?.adx14?.value, NaN);
  marketConditions.push(Number.isFinite(adx) ? adx < 20 ? 'RANGING' : adx >= 25 ? 'TRENDING' : 'TRANSITIONAL' : 'ADX_UNAVAILABLE');
  const m15 = analyses.find((item) => item.timeframe === 'M15');
  const volumeRatio = m15?.indicators?.tickVolumeRatio;
  marketConditions.push(volumeRatio?.status === 'AVAILABLE' && Number.isFinite(Number(volumeRatio.value))
    ? Number(volumeRatio.value) < 0.8 ? 'LOW_VOLUME' : Number(volumeRatio.value) > 1.2 ? 'HIGH_VOLUME' : 'NORMAL_VOLUME'
    : 'TICK_VOLUME_UNAVAILABLE');
  const market = context.market ?? snapshot.market ?? {};
  const sessions = decision.session?.active ?? market.session?.active ?? [];
  marketConditions.push(sessions.length ? `SESSION_${sessions.join('_PLUS_')}` : 'NO_ACTIVE_SESSION');
  const sessionSchedule = decision.session?.marketScheduleStatus ?? market.session?.marketScheduleStatus;
  if (sessionSchedule === 'WEEKEND_CLOSED') marketConditions.push('WEEKEND_CLOSED');
  if (!sessionSchedule) marketConditions.push('SESSION_SCHEDULE_UNKNOWN');
  const quote = market.quote ?? {};
  const atr14 = n(m15?.indicators?.atr14, NaN);
  const spreadAtrRatio = Number.isFinite(atr14) && atr14 > 0 && Number.isFinite(Number(quote.bid)) && Number.isFinite(Number(quote.ask))
    ? (Number(quote.ask) - Number(quote.bid)) / atr14 : null;
  const completeQuality = ['SCORE_PASS', 'CONFLUENCE_PASS', 'RR_PASS', 'NEWS_CLEAR'].every((tag) => setupQuality.includes(tag))
    && Number.isFinite(aligned) && aligned >= 3;
  const reviewClass = netTotal < 0
    ? completeQuality ? 'GOOD_TRADE_LOSS_REVIEW' : 'LOSS_REVIEW_REQUIRED'
    : closeReason === 'SL_AFTER_TP1' ? 'PROTECTED_EXIT_REVIEW' : netTotal > 0 ? 'WIN_REVIEW' : 'BREAKEVEN_REVIEW';
  return { exitResult: closeReason, setupQuality, marketConditions, reviewClass, spreadAtrRatio };
}

function insertTrade(db, { position, close, grossTotal, commissionTotal, swapTotal, netTotal, now, snapshot }) {
  const openedAt = Date.parse(position.opened_at);
  const closedAt = now.getTime();
  const seconds = Number.isFinite(openedAt) ? Math.max(0, Math.floor((closedAt - openedAt) / 1000)) : 0;
  const riskAmount = n(position.initial_risk_amount);
  const pnlR = riskAmount > 0 ? Number((netTotal / riskAmount).toFixed(6)) : null;
  const storedSnapshot = json(position.snapshot_json);
  const orderCreatedAt = Date.parse(db.prepare('SELECT created_at FROM orders WHERE id = ?').get(position.order_id)?.created_at ?? '');
  const firstFillAt = Date.parse(snapshot.firstFillAt ?? storedSnapshot.firstFillAt ?? '');
  const entryDelaySeconds = Number.isFinite(orderCreatedAt) && Number.isFinite(firstFillAt)
    ? Math.max(0, Math.floor((firstFillAt - orderCreatedAt) / 1000)) : null;
  const classification = classifyTrade(snapshot, close.closeReason, netTotal);
  const positionEvents = db.prepare(`
    SELECT event_type, old_state, new_state, reason, details_json, created_at
    FROM position_events WHERE position_id = ? ORDER BY created_at, rowid
  `).all(position.id).map((event) => ({ ...event, details: json(event.details_json) }));
  const completeSnapshot = { ...snapshot, classification, lifecycleEvents: positionEvents };
  const tradeId = randomUUID();
  db.prepare(`
    INSERT INTO trades (id, position_id, symbol, side, gross_pnl, net_pnl, pnl_r, commission, swap,
      close_reason, setup_quality, market_condition, opened_at, closed_at, duration_seconds,
      entry_delay_seconds, mfe, mae, snapshot_json, review_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tradeId, position.id, position.symbol, position.side, text(grossTotal), text(netTotal), pnlR,
    text(commissionTotal), text(swapTotal), close.closeReason, classification.setupQuality.join('|'),
    classification.marketConditions.join('|'), position.opened_at,
    now.toISOString(), seconds, entryDelaySeconds, text(position.mfe), text(position.mae), JSON.stringify(completeSnapshot), classification.reviewClass,
  );
  const saveSnapshot = db.prepare(`
    INSERT INTO trade_snapshots (id, trade_id, snapshot_type, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const fills = Array.isArray(snapshot.fills) ? snapshot.fills : snapshot.lastFill ? [snapshot.lastFill] : [];
  fills.forEach((fill, index) => saveSnapshot.run(
    randomUUID(), tradeId, index === 0 ? 'ENTRY' : 'PARTIAL_ENTRY', JSON.stringify(fill), fill.at ?? now.toISOString(),
  ));
  positionEvents.filter((event) => event.event_type === 'HIT_TP1').forEach((event) => saveSnapshot.run(
    randomUUID(), tradeId, 'TP1', JSON.stringify(event), event.created_at,
  ));
  db.prepare(`
    INSERT INTO trade_snapshots (id, trade_id, snapshot_type, snapshot_json, created_at)
    VALUES (?, ?, 'CLOSE', ?, ?)
  `).run(randomUUID(), tradeId, JSON.stringify(completeSnapshot), now.toISOString());
  return { tradeId, pnlR, classification };
}

function monitorPosition(db, initial, quote, fallbackCosts, now, { manualClose = false, withinTransaction = false, httpRequestId = null } = {}) {
  const savepoint = 'paper_position_transition';
  db.exec(withinTransaction ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  const commit = () => db.exec(withinTransaction ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
  const rollback = () => {
    if (withinTransaction) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else db.exec('ROLLBACK');
  };
  try {
    const position = db.prepare(`SELECT * FROM positions WHERE id = ? AND status IN ('OPEN', 'PARTIAL')`).get(initial.id);
    if (!position) { commit(); return { updated: false, reason: 'POSITION_NOT_OPEN' }; }
    const snapshot = json(position.snapshot_json);
    const correlationId = correlationForPosition(db, position, snapshot);
    const costs = usableCosts(snapshot.executionCosts ?? snapshot.paperCosts ?? fallbackCosts);
    if (!costs) { commit(); return { updated: false, reason: 'PAPER_COST_MODEL_UNAVAILABLE' }; }

    const priorSwapAt = Date.parse(position.last_swap_at ?? position.opened_at);
    if (!Number.isFinite(priorSwapAt) || now.getTime() < priorSwapAt) {
      appendAudit(db, {
        actor: 'paper-worker', eventType: 'PAPER_POSITION_CLOCK_SKEW', correlationId,
        configVersion: snapshot.configVersion ?? 'mtf-paper-v1', entityType: 'position', entityId: position.id,
        reason: 'Position monitoring time moved behind its last swap checkpoint; state was not advanced.',
        metadata: { lastSwapAt: position.last_swap_at, observedAt: now.toISOString() },
      }, now.toISOString());
      writeState(db, 'entryPaused', true, now.toISOString());
      commit();
      return { updated: false, reason: 'CLOCK_SKEW_ENTRY_PAUSED' };
    }

    const openLots = n(position.quantity_open_lots);
    const deltaDays = (now.getTime() - priorSwapAt) / 86_400_000;
    const swapDelta = money(openLots * costs.swapPerLotPerDay * deltaDays);
    const enginePosition = {
      ...position,
      side: position.side,
      quantityOpenLots: openLots,
      quantityInitialLots: n(position.quantity_initial_lots),
      entryPrice: n(position.entry_price),
      stopPrice: n(position.stop_price),
      takeProfit1: n(position.take_profit_1),
      takeProfit2: n(position.take_profit_2),
      tp1Hit: Boolean(position.tp1_hit),
      mfePrice: n(position.mfe),
      maePrice: n(position.mae),
      openedAt: position.opened_at,
    };
    const result = managePaperPosition(enginePosition, quote, now, costs, { closeRequested: manualClose });
    if (result.status === 'RECONCILIATION_REQUIRED') {
      appendAudit(db, {
        actor: 'paper-worker', eventType: 'PAPER_POSITION_RECONCILIATION_REQUIRED', correlationId,
        configVersion: snapshot.configVersion ?? 'mtf-paper-v1', entityType: 'position', entityId: position.id,
        reason: result.reason, metadata: { state: position.status },
      }, now.toISOString());
      writeState(db, 'entryPaused', true, now.toISOString());
      db.prepare(`
        INSERT INTO position_events (id, position_id, event_type, old_state, new_state, reason, details_json, created_at)
        VALUES (?, ?, 'RECONCILIATION_REQUIRED', ?, ?, ?, ?, ?)
      `).run(randomUUID(), position.id, position.status, position.status, result.reason,
        JSON.stringify({ correlationId, configVersion: snapshot.configVersion ?? null }), now.toISOString());
      commit();
      return { updated: false, reason: result.reason };
    }
    if (!result.markPrice || !Number.isFinite(Number(result.markPrice))) { commit(); return { updated: false, reason: result.reason }; }

    const eventGross = result.status === 'CLOSED' ? 0 : (result.events ?? []).reduce((sum, item) => sum + n(item.grossPnl), 0);
    const eventCommission = result.status === 'CLOSED' ? 0 : (result.events ?? []).reduce((sum, item) => sum + n(item.commission), 0);
    const closeGross = result.status === 'CLOSED' ? n(result.grossPnl) : 0;
    const closeCommission = result.status === 'CLOSED' ? n(result.commission) : 0;
    const grossTotal = n(position.realized_gross_pnl) + eventGross + closeGross;
    const commissionTotal = n(position.commission_paid) + eventCommission + closeCommission;
    const swapTotal = n(position.swap_paid) + swapDelta;
    const realizedDelta = (result.events ?? []).reduce((sum, item) => sum + n(item.grossPnl) - n(item.commission), 0)
      + (result.status === 'CLOSED' ? closeGross - closeCommission : 0) - swapDelta;
    const realizedTotal = money(n(position.realized_pnl) + realizedDelta);
    const mark = n(result.markPrice);
    const direction = position.side === 'LONG' ? 1 : -1;
    const unrealizedGross = (mark - n(position.entry_price)) * direction * n(result.quantityOpenLots, openLots)
      * costs.contractSize * costs.quoteToAccountRate;
    const estimatedExitCommission = n(result.quantityOpenLots, openLots) * costs.commissionPerLot;
    const unrealized = result.status === 'CLOSED' ? 0 : money(unrealizedGross - estimatedExitCommission - swapTotal);
    const nextStatus = result.status === 'CLOSED' ? 'CLOSED' : result.status === 'PARTIAL' ? 'PARTIAL' : position.status;
    const nextSnapshot = {
      ...snapshot,
      correlationId,
      lastMarketQuote: { bid: quote.bid, ask: quote.ask, observedAt: quote.observedAt ?? null },
      lastPositionEvents: result.events ?? [],
    };

    if (result.events?.length || result.status === 'CLOSED') {
      appendAudit(db, {
        actor: manualClose ? 'operator' : 'paper-worker',
        eventType: manualClose ? 'PAPER_POSITION_MANUALLY_CLOSED' : result.status === 'CLOSED' ? 'PAPER_POSITION_CLOSED' : 'PAPER_POSITION_UPDATED',
        correlationId, entityType: 'position', entityId: position.id,
        configVersion: snapshot.configVersion ?? 'mtf-paper-v1',
        reason: result.closeReason ?? result.events?.map((event) => event.type).join(', ') ?? 'Paper position state transition.',
        metadata: {
          events: result.events ?? [], quoteObservedAt: quote.observedAt ?? null, dataSource: quote.source, manualClose,
          ...httpRequestAuditMetadata(httpRequestId),
        },
      }, now.toISOString());
    }

    db.prepare(`
      UPDATE positions SET status = ?, quantity_open_lots = ?, mark_price = ?, stop_price = ?, tp1_hit = ?,
        realized_pnl = ?, realized_gross_pnl = ?, commission_paid = ?, swap_paid = ?, unrealized_pnl = ?,
        mfe = ?, mae = ?, last_swap_at = ?, closed_at = ?, close_reason = ?, snapshot_json = ?
      WHERE id = ?
    `).run(
      nextStatus, text(result.quantityOpenLots ?? openLots), text(mark),
      text(result.stopPrice ?? position.stop_price), result.tp1Hit === undefined ? position.tp1_hit : result.tp1Hit ? 1 : 0,
      text(realizedTotal), text(grossTotal), text(commissionTotal), text(swapTotal), text(unrealized),
      text(result.mfePrice ?? position.mfe), text(result.maePrice ?? position.mae), now.toISOString(),
      result.status === 'CLOSED' ? now.toISOString() : null, result.closeReason ?? null, JSON.stringify(nextSnapshot), position.id,
    );

    for (const event of result.events ?? []) {
      db.prepare(`
        INSERT INTO position_events (id, position_id, event_type, old_state, new_state, reason, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), position.id, event.type, position.status, nextStatus, event.type,
        JSON.stringify({ ...event, correlationId, configVersion: snapshot.configVersion ?? null,
          quote: { bid: quote.bid, ask: quote.ask, observedAt: quote.observedAt ?? null } }), now.toISOString());
      if (result.status !== 'CLOSED' && event.grossPnl) addLedger(db, { positionId: position.id, entryType: 'REALIZED_PARTIAL_GROSS', amount: event.grossPnl, currency: costs.accountCurrency, details: event, now });
      if (result.status !== 'CLOSED' && event.commission) addLedger(db, { positionId: position.id, entryType: 'EXIT_COMMISSION', amount: -n(event.commission), currency: costs.accountCurrency, details: event, now });
    }
    if (swapDelta) addLedger(db, { positionId: position.id, entryType: 'SWAP_ACCRUAL', amount: -swapDelta, currency: costs.accountCurrency, details: { openLots, deltaDays }, now });

    if (result.status === 'CLOSED') {
      const tradeSnapshot = { ...nextSnapshot, exit: { price: result.exitPrice, quote, reason: result.closeReason, costs } };
      const trade = insertTrade(db, { position, close: result, grossTotal, commissionTotal, swapTotal, netTotal: money(grossTotal - commissionTotal - swapTotal), now, snapshot: tradeSnapshot });
      db.prepare('UPDATE signals SET status = ? WHERE id = (SELECT signal_id FROM orders WHERE id = ?)').run('CLOSED', position.order_id);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(position.order_id);
      if (order?.status === 'PARTIAL') expireOrderInsideTransaction(db, order, now, 'POSITION_CLOSED_REMAINDER_CANCELLED');
      addLedger(db, { positionId: position.id, entryType: 'REALIZED_EXIT_NET', amount: n(result.grossPnl) - n(result.commission), currency: costs.accountCurrency, details: { tradeId: trade.tradeId, closeReason: result.closeReason }, now });
    } else if (result.events?.some((event) => event.type === 'HIT_TP1')) {
      db.prepare('UPDATE signals SET status = ? WHERE id = (SELECT signal_id FROM orders WHERE id = ?)').run('PARTIAL', position.order_id);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(position.order_id);
      if (order?.status === 'PARTIAL') expireOrderInsideTransaction(db, order, now, 'TP1_REMAINDER_CANCELLED');
    }

    commit();
    return { updated: true, closed: result.status === 'CLOSED', events: result.events ?? [] };
  } catch (error) {
    rollback();
    throw error;
  }
}

export function closePaperPosition(db, { positionId, quote, costs = null, now = new Date(), withinTransaction = false, httpRequestId = null } = {}) {
  if (typeof positionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(positionId)) {
    throw new TypeError('Paper position ID is invalid.');
  }
  if (!quoteIsFreshMarketData(quote, now)) return { updated: false, reason: 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED' };
  const position = db.prepare(`SELECT id FROM positions WHERE id = ? AND status IN ('OPEN', 'PARTIAL')`).get(positionId);
  if (!position) return { updated: false, reason: 'POSITION_NOT_OPEN' };
  return monitorPosition(db, position, quote, costs, now, { manualClose: true, withinTransaction, httpRequestId });
}

function expireOrderInsideTransaction(db, order, now, reason) {
  const correlationId = correlationForOrder(db, order);
  appendAudit(db, {
    actor: 'paper-worker', eventType: 'PAPER_ORDER_REMAINDER_CANCELLED', correlationId,
    configVersion: json(order.snapshot_json).configVersion ?? 'mtf-paper-v1', entityType: 'order', entityId: order.id,
    reason, metadata: { remainingLots: order.remaining_quantity_lots },
  }, now.toISOString());
  db.prepare(`UPDATE orders SET status = 'CANCELLED', remaining_quantity_lots = '0', updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), order.id);
}

function fillOrder(db, initial, quote, fallbackCosts, now) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND status IN ('PENDING', 'PARTIAL')`).get(initial.id);
    if (!order) { db.exec('COMMIT'); return { updated: false }; }
    const orderSnapshot = json(order.snapshot_json);
    const correlationId = correlationForOrder(db, order, orderSnapshot);
    if (Date.parse(order.expires_at) <= now.getTime()) {
      appendAudit(db, {
        actor: 'paper-worker', eventType: 'PAPER_ORDER_EXPIRED', correlationId, entityType: 'order', entityId: order.id,
        configVersion: orderSnapshot.configVersion ?? 'mtf-paper-v1',
        reason: 'Paper pending order expired before a new fill.', metadata: { remainingLots: order.remaining_quantity_lots },
      }, now.toISOString());
      db.prepare(`UPDATE orders SET status = 'EXPIRED', remaining_quantity_lots = '0', updated_at = ? WHERE id = ?`).run(now.toISOString(), order.id);
      db.prepare(`UPDATE signals SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'`).run(order.signal_id);
      db.exec('COMMIT');
      return { updated: true, expired: true };
    }

    const riskState = loadFreshRiskMetrics(db, now);
    if (riskState.freshness !== 'FRESH') {
      db.exec('COMMIT');
      return { updated: false, reason: riskState.reason ?? 'RISK_STATE_UNAVAILABLE' };
    }
    const riskLimits = { ...baseConfig.risk, ...(orderSnapshot.config ?? {}) };
    const currentGuard = evaluateRiskGuard({
      dailyLossR: riskState.dailyLossR,
      drawdownPct: riskState.drawdownPct,
      openRiskPct: riskState.openRiskPct,
      proposedRiskPct: 0,
      limits: riskLimits,
    });
    if (!currentGuard.allowed) {
      const position = db.prepare('SELECT id FROM positions WHERE order_id = ? AND status IN (\'OPEN\', \'PARTIAL\')').get(order.id);
      appendAudit(db, {
        actor: 'paper-worker', eventType: 'PAPER_ORDER_RISK_REJECTED', correlationId,
        configVersion: orderSnapshot.configVersion ?? 'mtf-paper-v1',
        entityType: 'order', entityId: order.id,
        reason: currentGuard.reasons.join(', '),
        metadata: {
          riskStateUpdatedAt: riskState.updatedAt,
          dailyLossR: riskState.dailyLossR,
          drawdownPct: riskState.drawdownPct,
          openRiskPct: riskState.openRiskPct,
          positionId: position?.id ?? null,
        },
      }, now.toISOString());
      db.prepare('UPDATE orders SET status = ?, remaining_quantity_lots = \'0\', updated_at = ? WHERE id = ?')
        .run(position ? 'CANCELLED' : 'REJECTED', now.toISOString(), order.id);
      if (!position) db.prepare('UPDATE signals SET status = \'REJECTED\' WHERE id = ?').run(order.signal_id);
      writeState(db, 'entryPaused', true, now.toISOString());
      db.exec('COMMIT');
      return { updated: true, status: position ? 'CANCELLED' : 'REJECTED', reason: currentGuard.reasons[0], reasons: currentGuard.reasons };
    }

    const costs = usableCosts(orderSnapshot.paperCosts ?? fallbackCosts);
    if (!costs) { db.exec('COMMIT'); return { updated: false, reason: 'PAPER_COST_MODEL_UNAVAILABLE' }; }
    const position = db.prepare('SELECT * FROM positions WHERE order_id = ?').get(order.id);
    const positionSnapshot = position ? json(position.snapshot_json, orderSnapshot) : orderSnapshot;
    const priorFills = Array.isArray(positionSnapshot.fills) ? positionSnapshot.fills : [];
    const lastFill = positionSnapshot.lastFill ?? priorFills.at(-1) ?? null;
    const lastFillQuoteAt = Date.parse(lastFill?.quote?.observedAt ?? lastFill?.quoteObservedAt ?? '');
    const currentQuoteAt = Date.parse(quote.observedAt ?? '');
    if (Number.isFinite(lastFillQuoteAt) && Number.isFinite(currentQuoteAt) && currentQuoteAt <= lastFillQuoteAt) {
      db.exec('COMMIT');
      return {
        updated: false,
        reason: currentQuoteAt === lastFillQuoteAt ? 'QUOTE_ALREADY_MATCHED' : 'QUOTE_NOT_NEWER_THAN_LAST_FILL',
      };
    }
    if (position?.tp1_hit) {
      expireOrderInsideTransaction(db, order, now, 'TP1_REMAINDER_CANCELLED');
      db.exec('COMMIT');
      return { updated: true, cancelled: true };
    }
    const adapter = new PaperBrokerAdapter({ costs });
    const fill = adapter.matchPendingOrder({
      ...order,
      orderType: order.order_type,
      entryPrice: n(order.entry_price),
      quantityLots: n(order.remaining_quantity_lots),
      expiresAt: order.expires_at,
    }, quote, now);
    if (fill.status === 'PENDING' || fill.status === 'HELD') { db.exec('COMMIT'); return { updated: false, reason: fill.reason }; }
    if (fill.status === 'REJECTED' || fill.status === 'EXPIRED') {
      appendAudit(db, {
        actor: 'paper-worker', eventType: fill.status === 'EXPIRED' ? 'PAPER_ORDER_EXPIRED' : 'PAPER_ORDER_REJECTED',
        correlationId, configVersion: orderSnapshot.configVersion ?? 'mtf-paper-v1',
        entityType: 'order', entityId: order.id, reason: fill.reason,
        metadata: { quoteObservedAt: quote.observedAt ?? null },
      }, now.toISOString());
      db.prepare('UPDATE orders SET status = ?, remaining_quantity_lots = ?, updated_at = ? WHERE id = ?')
        .run(fill.status, '0', now.toISOString(), order.id);
      db.prepare('UPDATE signals SET status = ? WHERE id = ? AND status = \'PENDING\'')
        .run(fill.status, order.signal_id);
      db.exec('COMMIT');
      return { updated: true, status: fill.status, reason: fill.reason };
    }

    const side = order.side === 'BUY' ? 'LONG' : 'SHORT';
    const previousInitial = position ? n(position.quantity_initial_lots) : 0;
    const previousOpen = position ? n(position.quantity_open_lots) : 0;
    const previousEntry = position ? n(position.entry_price) : 0;
    const nextInitial = Number((previousInitial + fill.filledLots).toFixed(8));
    const nextOpen = Number((previousOpen + fill.filledLots).toFixed(8));
    const averageEntry = (previousInitial * previousEntry + fill.filledLots * fill.fillPrice) / nextInitial;
    const initialRisk = n(orderSnapshot.sizing?.riskAmount) * nextInitial / n(order.quantity_lots, nextInitial);
    const previousCommission = position ? n(position.commission_paid) : 0;
    const nextCommission = money(previousCommission + fill.commission);
    const nextRealized = money(n(position?.realized_pnl) - fill.commission);
    const positionId = position?.id ?? randomUUID();
    const currentPrice = side === 'LONG' ? n(quote.bid) : n(quote.ask);
    const unrealized = money((currentPrice - averageEntry) * (side === 'LONG' ? 1 : -1) * nextOpen * costs.contractSize * costs.quoteToAccountRate
      - nextOpen * costs.commissionPerLot);
    const previousSnapshot = position ? json(position.snapshot_json, orderSnapshot) : {};
    const storedFill = { ...fill, at: now.toISOString(), quote: { bid: quote.bid, ask: quote.ask, observedAt: quote.observedAt ?? null, receivedAt: quote.receivedAt ?? null } };
    const mergedSnapshot = {
      ...orderSnapshot,
      ...previousSnapshot,
      correlationId,
      executionCosts: costs,
      firstFillAt: previousSnapshot.firstFillAt ?? now.toISOString(),
      fills: [...(Array.isArray(previousSnapshot.fills) ? previousSnapshot.fills : []), storedFill],
      lastFill: storedFill,
    };
    appendAudit(db, {
      actor: 'paper-worker', eventType: fill.status === 'PARTIAL' ? 'PAPER_ORDER_PARTIALLY_FILLED' : 'PAPER_ORDER_FILLED',
      correlationId, entityType: 'order', entityId: order.id,
      reason: 'Paper fill matched against a fresh broker bid/ask quote; no live order was sent.',
      configVersion: orderSnapshot.configVersion ?? 'mtf-paper-v1',
      metadata: { fill, quoteObservedAt: quote.observedAt ?? null, source: quote.source },
    }, now.toISOString());

    if (position) {
      db.prepare(`
        UPDATE positions SET status = ?, quantity_open_lots = ?, quantity_initial_lots = ?, entry_price = ?, mark_price = ?,
          realized_pnl = ?, commission_paid = ?, initial_risk_amount = ?, last_swap_at = ?, unrealized_pnl = ?, snapshot_json = ?
        WHERE id = ?
      `).run(position.status, text(nextOpen), text(nextInitial), text(averageEntry), text(currentPrice), text(nextRealized),
        text(nextCommission), text(initialRisk), now.toISOString(), text(unrealized), JSON.stringify(mergedSnapshot), positionId);
    } else {
      db.prepare(`
        INSERT INTO positions (id, order_id, symbol, side, status, quantity_open_lots, quantity_initial_lots, entry_price,
          mark_price, stop_price, take_profit_1, take_profit_2, tp1_hit, realized_pnl, unrealized_pnl, mfe, mae,
          opened_at, closed_at, close_reason, snapshot_json, realized_gross_pnl, commission_paid, swap_paid,
          initial_risk_amount, last_swap_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '0', '0', ?, NULL, NULL, ?, '0', ?, '0', ?, ?)
      `).run(
        positionId, order.id, order.symbol, side, text(nextOpen), text(nextInitial), text(averageEntry), text(currentPrice),
        order.stop_price, order.take_profit_1, order.take_profit_2, text(nextRealized), text(unrealized), now.toISOString(),
        JSON.stringify(mergedSnapshot), text(nextCommission), text(initialRisk), now.toISOString(),
      );
    }
    db.prepare(`UPDATE orders SET status = ?, remaining_quantity_lots = ?, updated_at = ? WHERE id = ?`)
      .run(fill.status === 'PARTIAL' ? 'PARTIAL' : 'FILLED', text(fill.remainingLots), now.toISOString(), order.id);
    db.prepare('UPDATE signals SET status = ? WHERE id = ?')
      .run(fill.status === 'PARTIAL' ? 'PARTIAL' : 'OPEN', order.signal_id);
    db.prepare(`
      INSERT INTO position_events (id, position_id, event_type, old_state, new_state, reason, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), positionId, fill.status === 'PARTIAL' ? 'PARTIAL_FILL' : 'FILL', position?.status ?? 'PENDING', position?.status ?? 'OPEN',
      fill.reason, JSON.stringify({ ...storedFill, correlationId, configVersion: orderSnapshot.configVersion ?? null, orderId: order.id }), now.toISOString());
    if (fill.commission) addLedger(db, { positionId, entryType: 'ENTRY_COMMISSION', amount: -fill.commission, currency: costs.accountCurrency, details: { orderId: order.id }, now });
    db.exec('COMMIT');
    return { updated: true, status: fill.status, positionId, filledLots: fill.filledLots, remainingLots: fill.remainingLots };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function reconcilePaperExecution(db, { quote = null, costs = null, paperMode = true, now = new Date(), limit = 100 } = {}) {
  const summary = { expired: 0, cancelled: 0, filled: 0, monitored: 0, closed: 0, skipped: 0, reasons: [] };
  const pending = db.prepare(`SELECT * FROM orders WHERE status IN ('PENDING', 'PARTIAL') ORDER BY created_at LIMIT ?`).all(limit);
  for (const order of pending) {
    if (Date.parse(order.expires_at) <= now.getTime() && expireOrder(db, order, now)) summary.expired += 1;
  }

  if (!paperMode) {
    const cancellable = db.prepare("SELECT * FROM orders WHERE status IN ('PENDING', 'PARTIAL') ORDER BY created_at LIMIT ?").all(limit);
    for (const order of cancellable) if (cancelOrderForPaperOff(db, order, now)) summary.cancelled += 1;
    summary.reasons.push('PAPER_MODE_DISABLED');
  }

  const positions = db.prepare(`SELECT * FROM positions WHERE status IN ('OPEN', 'PARTIAL') ORDER BY opened_at LIMIT ?`).all(limit);
  // With no pending orders or open positions there is nothing to reconcile.
  // This keeps the heartbeat cheap without weakening any fill/close gate when
  // paper execution has active work to manage.
  if (!pending.length && !positions.length) return summary;

  if (!quoteIsFreshMarketData(quote, now)) {
    summary.skipped += 1;
    summary.reasons.push('VERIFIED_FRESH_BROKER_QUOTE_REQUIRED');
    return summary;
  }

  for (const position of positions) {
    const result = monitorPosition(db, position, quote, costs, now);
    if (result.updated) {
      summary.monitored += 1;
      if (result.closed) summary.closed += 1;
    } else if (result.reason) {
      summary.skipped += 1;
      if (!summary.reasons.includes(result.reason)) summary.reasons.push(result.reason);
    }
  }

  if (!paperMode) return summary;

  const currentPending = db.prepare(`SELECT * FROM orders WHERE status IN ('PENDING', 'PARTIAL') ORDER BY created_at LIMIT ?`).all(limit);
  for (const order of currentPending) {
    const result = fillOrder(db, order, quote, costs, now);
    if (result.updated && (result.status === 'FILLED' || result.status === 'PARTIAL')) summary.filled += 1;
    if (result.updated && result.status === 'REJECTED') {
      summary.skipped += 1;
      for (const reason of result.reasons ?? [result.reason]) {
        if (reason && !summary.reasons.includes(reason)) summary.reasons.push(reason);
      }
    }
    if (!result.updated && result.reason) {
      summary.skipped += 1;
      if (!summary.reasons.includes(result.reason)) summary.reasons.push(result.reason);
    }
  }
  return summary;
}
