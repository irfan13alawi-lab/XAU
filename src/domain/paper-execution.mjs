const number = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const positive = (value) => number(value) && Number(value) > 0;

function validateCosts(costs) {
  if (!costs || !number(costs.slippagePrice) || Number(costs.slippagePrice) < 0
    || !number(costs.commissionPerLot) || Number(costs.commissionPerLot) < 0
    || !number(costs.swapPerLotPerDay) || Number(costs.swapPerLotPerDay) < 0
    || !number(costs.fillLatencyMs) || Number(costs.fillLatencyMs) < 0 || Number(costs.fillLatencyMs) > 120_000
    || !number(costs.fillRatio) || Number(costs.fillRatio) <= 0 || Number(costs.fillRatio) > 1
    || !positive(costs.contractSize) || !positive(costs.quoteToAccountRate)
    || !positive(costs.lotStep) || !positive(costs.minimumLot)
    || !number(costs.breakEvenOffsetPrice)) {
    throw new TypeError('Paper fill assumptions must be explicit, finite, and non-negative.');
  }
  const minimumLotSteps = Number(costs.minimumLot) / Number(costs.lotStep);
  if (Math.abs(minimumLotSteps - Math.round(minimumLotSteps)) > 1e-8) {
    throw new TypeError('Paper minimum lot must align with the configured lot step.');
  }
}

function roundDown(value, step) {
  return Number((Math.floor((Number(value) + 1e-12) / Number(step)) * Number(step)).toFixed(8));
}

export function matchPendingOrder(order, quote, now = new Date(), costs) {
  validateCosts(costs);
  const expiresAt = Date.parse(order?.expiresAt ?? order?.expires_at ?? '');
  if (!Number.isFinite(expiresAt)) return { status: 'REJECTED', reason: 'ORDER_EXPIRY_INVALID' };
  if (now.getTime() >= expiresAt) return { status: 'EXPIRED', reason: 'PENDING_EXPIRED' };
  if (!quote || quote.source !== 'BROKER' || quote.dataFreshness !== 'FRESH' || !positive(quote.bid) || !positive(quote.ask) || Number(quote.ask) < Number(quote.bid)) {
    return { status: 'HELD', reason: 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED' };
  }
  if (!['BUY', 'SELL'].includes(order.side) || !['LIMIT', 'STOP'].includes(order.orderType ?? order.order_type) || !positive(order.entryPrice ?? order.entry_price) || !positive(order.quantityLots ?? order.quantity_lots)) {
    return { status: 'REJECTED', reason: 'ORDER_FIELDS_INVALID' };
  }
  const requested = Number(order.quantityLots ?? order.quantity_lots);
  const lotSteps = requested / Number(costs.lotStep);
  if (requested + 1e-8 < Number(costs.minimumLot) || Math.abs(lotSteps - Math.round(lotSteps)) > 1e-8) {
    return { status: 'REJECTED', reason: 'ORDER_VOLUME_INVALID' };
  }
  const createdAt = Date.parse(order.createdAt ?? order.created_at ?? '');
  const quoteObservedAt = Date.parse(quote.observedAt ?? quote.receivedAt ?? '');
  if (!Number.isFinite(createdAt) || !Number.isFinite(quoteObservedAt) || quoteObservedAt > now.getTime()) {
    return { status: 'HELD', reason: 'ORDER_OR_QUOTE_TIMESTAMP_INVALID' };
  }
  const eligibleAt = createdAt + Number(costs.fillLatencyMs);
  if (now.getTime() < eligibleAt || quoteObservedAt < eligibleAt) {
    return { status: 'HELD', reason: 'SIMULATED_FILL_LATENCY_WAIT', eligibleAt: new Date(eligibleAt).toISOString() };
  }
  const orderType = order.orderType ?? order.order_type;
  const entry = Number(order.entryPrice ?? order.entry_price);
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const triggered = order.side === 'BUY'
    ? orderType === 'LIMIT' ? ask <= entry : ask >= entry
    : orderType === 'LIMIT' ? bid >= entry : bid <= entry;
  if (!triggered) return { status: 'PENDING', reason: 'PRICE_NOT_TRIGGERED' };

  const ratioTarget = roundDown(requested * Number(costs.fillRatio), Number(costs.lotStep));
  // Exchanges cannot execute below the minimum lot. Round a smaller simulated
  // allocation up to the smallest valid amount, capped at the remaining order.
  const filledLots = Math.min(requested, Math.max(ratioTarget, Number(costs.minimumLot)));
  if (filledLots < Number(costs.minimumLot)) return { status: 'HELD', reason: 'PARTIAL_FILL_BELOW_MINIMUM_LOT' };
  const referencePrice = order.side === 'BUY' ? ask : bid;
  const adversePrice = referencePrice + (order.side === 'BUY' ? 1 : -1) * Number(costs.slippagePrice);
  const fillPrice = orderType === 'LIMIT'
    ? order.side === 'BUY' ? Math.min(entry, adversePrice) : Math.max(entry, adversePrice)
    : adversePrice;
  if (!positive(fillPrice)) return { status: 'REJECTED', reason: 'FILL_PRICE_INVALID' };
  const remainingLots = Number((requested - filledLots).toFixed(8));
  return {
    status: remainingLots > 0 ? 'PARTIAL' : 'FILLED',
    reason: 'BID_ASK_TRIGGER',
    filledLots,
    remainingLots,
    fillPrice,
    referencePrice,
    commission: Number((filledLots * Number(costs.commissionPerLot)).toFixed(2)),
    quoteObservedAt: new Date(quoteObservedAt).toISOString(),
    fillLatencyMs: Number(costs.fillLatencyMs),
  };
}

function movement(position, executablePrice) {
  const entry = Number(position.entryPrice ?? position.entry_price);
  return position.side === 'LONG' ? executablePrice - entry : entry - executablePrice;
}

function adverseMarketExitPrice(position, referencePrice, costs) {
  return Number((Number(referencePrice) + (position.side === 'LONG' ? -1 : 1) * Number(costs.slippagePrice)).toFixed(8));
}

function gapThroughStopPrice(position, executablePrice, stopPrice) {
  const distance = position.side === 'LONG'
    ? Number(stopPrice) - Number(executablePrice)
    : Number(executablePrice) - Number(stopPrice);
  return Number(Math.max(0, distance).toFixed(8));
}

function targetLimitExitPrice(position, referencePrice, targetPrice, costs) {
  const adverse = adverseMarketExitPrice(position, referencePrice, costs);
  return Number((position.side === 'LONG' ? Math.max(Number(targetPrice), adverse) : Math.min(Number(targetPrice), adverse)).toFixed(8));
}

export function managePaperPosition(position, quote, now = new Date(), costs, { closeRequested = false } = {}) {
  validateCosts(costs);
  if (!quote || quote.source !== 'BROKER' || quote.dataFreshness !== 'FRESH' || !positive(quote.bid) || !positive(quote.ask) || Number(quote.ask) < Number(quote.bid)) {
    return { status: position.status, events: [], reason: 'VERIFIED_FRESH_BROKER_QUOTE_REQUIRED' };
  }
  if (!['LONG', 'SHORT'].includes(position.side) || !positive(position.quantityOpenLots ?? position.quantity_open_lots)
    || !positive(position.entryPrice ?? position.entry_price) || !positive(position.stopPrice ?? position.stop_price)
    || !positive(position.takeProfit1 ?? position.take_profit_1) || !positive(position.takeProfit2 ?? position.take_profit_2)) {
    return { status: 'RECONCILIATION_REQUIRED', events: [], reason: 'POSITION_STATE_INVALID' };
  }

  const sidePrice = position.side === 'LONG' ? Number(quote.bid) : Number(quote.ask);
  const sideMove = movement(position, sidePrice);
  const openLots = Number(position.quantityOpenLots ?? position.quantity_open_lots);
  const initialLots = Number(position.quantityInitialLots ?? position.quantity_initial_lots ?? openLots);
  const entry = Number(position.entryPrice ?? position.entry_price);
  const stop = Number(position.stopPrice ?? position.stop_price);
  const tp1 = Number(position.takeProfit1 ?? position.take_profit_1);
  const tp2 = Number(position.takeProfit2 ?? position.take_profit_2);
  const tp1Hit = Boolean(position.tp1Hit ?? position.tp1_hit);
  const crossedStop = position.side === 'LONG' ? sidePrice <= stop : sidePrice >= stop;
  const crossedTp1 = position.side === 'LONG' ? sidePrice >= tp1 : sidePrice <= tp1;
  const crossedTp2 = position.side === 'LONG' ? sidePrice >= tp2 : sidePrice <= tp2;
  const events = [];
  const currentMfe = Math.max(Number(position.mfePrice ?? 0), sideMove, 0);
  const currentMae = Math.max(Number(position.maePrice ?? 0), -sideMove, 0);
  const base = { mfePrice: currentMfe, maePrice: currentMae, markPrice: sidePrice, observedAt: quote.observedAt ?? now.toISOString() };

  if (closeRequested) {
    const exitPrice = adverseMarketExitPrice(position, sidePrice, costs);
    if (!positive(exitPrice)) return { ...base, status: 'RECONCILIATION_REQUIRED', events: [], reason: 'PAPER_EXIT_PRICE_INVALID' };
    const grossPnl = movement(position, exitPrice) * openLots * Number(costs.contractSize) * Number(costs.quoteToAccountRate);
    const commission = Number((openLots * Number(costs.commissionPerLot)).toFixed(2));
    return {
      ...base,
      status: 'CLOSED',
      quantityOpenLots: 0,
      closeReason: 'MANUAL_CLOSE',
      exitPrice,
      grossPnl: Number(grossPnl.toFixed(2)),
      commission,
      swap: 0,
      netPnl: Number((grossPnl - commission).toFixed(2)),
      events: [{ type: 'MANUAL_CLOSE', price: exitPrice, referencePrice: sidePrice, slippagePrice: Number(costs.slippagePrice), quantityLots: openLots, grossPnl: Number(grossPnl.toFixed(2)), commission }],
    };
  }

  // Conservative same-quote policy: a stop touch wins over any target touch.
  if (crossedStop) {
    const reason = tp1Hit ? 'SL_AFTER_TP1' : 'SL_DIRECT';
    const stopGapPrice = gapThroughStopPrice(position, sidePrice, stop);
    const exitPrice = adverseMarketExitPrice(position, sidePrice, costs);
    if (!positive(exitPrice)) return { ...base, status: 'RECONCILIATION_REQUIRED', events: [], reason: 'PAPER_EXIT_PRICE_INVALID' };
    const grossPnl = movement(position, exitPrice) * openLots * Number(costs.contractSize) * Number(costs.quoteToAccountRate);
    const commission = Number((openLots * Number(costs.commissionPerLot)).toFixed(2));
    const openedAt = Date.parse(position.openedAt ?? position.opened_at ?? now.toISOString());
    const elapsedDays = Number.isFinite(openedAt) ? Math.max(0, (now.getTime() - openedAt) / 86_400_000) : 0;
    const swap = Number((openLots * Number(costs.swapPerLotPerDay) * elapsedDays).toFixed(2));
    return {
      ...base,
      status: 'CLOSED',
      quantityOpenLots: 0,
      closeReason: reason,
      exitPrice,
      grossPnl: Number(grossPnl.toFixed(2)),
      commission,
      swap,
      netPnl: Number((grossPnl - commission - swap).toFixed(2)),
      events: [{
        type: reason,
        price: exitPrice,
        referencePrice: sidePrice,
        stopPrice: stop,
        stopGapPrice,
        slippagePrice: Number(costs.slippagePrice),
        quantityLots: openLots,
      }],
    };
  }

  if (!tp1Hit && crossedTp1) {
    const lotStep = Number(costs.lotStep);
    const partialLots = roundDown(initialLots * 0.5, lotStep);
    if (partialLots < Number(costs.minimumLot) || partialLots >= openLots) {
      const breakEvenOffset = Math.abs(Number(costs.breakEvenOffsetPrice));
      const breakEven = position.side === 'LONG' ? entry + breakEvenOffset : entry - breakEvenOffset;
      return {
        ...base,
        status: 'PARTIAL',
        tp1Hit: true,
        quantityOpenLots: openLots,
        stopPrice: breakEven,
        realizedPnlDelta: 0,
        events: [{
          type: 'HIT_TP1', price: sidePrice, quantityLots: 0, grossPnl: 0, commission: 0,
          partialCloseUnavailableReason: 'TP1_PARTIAL_BELOW_MINIMUM_LOT',
        }],
        reason: 'TP1_REACHED_NO_PARTIAL_MIN_LOT_REMAINDER_PROTECTED',
      };
    }
    const exitPrice = targetLimitExitPrice(position, sidePrice, tp1, costs);
    if (!positive(exitPrice)) return { ...base, status: 'RECONCILIATION_REQUIRED', events: [], reason: 'PAPER_EXIT_PRICE_INVALID' };
    const grossPnl = movement(position, exitPrice) * partialLots * Number(costs.contractSize) * Number(costs.quoteToAccountRate);
    const commission = Number((partialLots * Number(costs.commissionPerLot)).toFixed(2));
    const breakEvenOffset = Math.abs(Number(costs.breakEvenOffsetPrice));
    const breakEven = position.side === 'LONG' ? entry + breakEvenOffset : entry - breakEvenOffset;
    events.push({ type: 'HIT_TP1', price: exitPrice, referencePrice: sidePrice, slippagePrice: Number(costs.slippagePrice), quantityLots: partialLots, grossPnl: Number(grossPnl.toFixed(2)), commission });
    return {
      ...base,
      status: 'PARTIAL',
      tp1Hit: true,
      quantityOpenLots: Number((openLots - partialLots).toFixed(8)),
      stopPrice: breakEven,
      realizedPnlDelta: Number((grossPnl - commission).toFixed(2)),
      events,
      reason: 'TP1_PARTIAL_CONFIRMED_BREAK_EVEN_SET',
    };
  }

  if (tp1Hit && crossedTp2) {
    const exitPrice = targetLimitExitPrice(position, sidePrice, tp2, costs);
    if (!positive(exitPrice)) return { ...base, status: 'RECONCILIATION_REQUIRED', events: [], reason: 'PAPER_EXIT_PRICE_INVALID' };
    const grossPnl = movement(position, exitPrice) * openLots * Number(costs.contractSize) * Number(costs.quoteToAccountRate);
    const commission = Number((openLots * Number(costs.commissionPerLot)).toFixed(2));
    return {
      ...base,
      status: 'CLOSED',
      quantityOpenLots: 0,
      closeReason: 'HIT_TP2',
      exitPrice,
      grossPnl: Number(grossPnl.toFixed(2)),
      commission,
      swap: 0,
      netPnl: Number((grossPnl - commission).toFixed(2)),
      events: [{ type: 'HIT_TP2', price: exitPrice, referencePrice: sidePrice, slippagePrice: Number(costs.slippagePrice), quantityLots: openLots }],
    };
  }

  return { ...base, status: position.status, events, reason: 'POSITION_MONITORED' };
}

export class PaperBrokerAdapter {
  constructor({ costs }) {
    validateCosts(costs);
    this.costs = Object.freeze({ ...costs });
  }

  matchPendingOrder(order, quote, now = new Date()) {
    return matchPendingOrder(order, quote, now, this.costs);
  }

  managePosition(position, quote, now = new Date(), options) {
    return managePaperPosition(position, quote, now, this.costs, options);
  }
}
