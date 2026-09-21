const MAX_RISK_STATE_AGE_MS = 30_000;

function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function positive(value) {
  return finite(value) && Number(value) > 0;
}

function currencyOf(snapshot) {
  const value = snapshot?.account?.currency
    ?? snapshot?.snapshots?.account?.currency
    ?? snapshot?.executionCosts?.accountCurrency
    ?? null;
  return typeof value === 'string' ? value.trim().toUpperCase() : null;
}

function parseSnapshot(value) {
  try {
    const snapshot = JSON.parse(value ?? '{}');
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function calculatePaperOpenRiskPct(db, { equity, currency } = {}) {
  if (!positive(equity) || typeof currency !== 'string' || !currency.trim()) return null;
  const accountCurrency = currency.trim().toUpperCase();
  let amount = 0;

  const positions = db.prepare(`
    SELECT initial_risk_amount, quantity_open_lots, quantity_initial_lots, snapshot_json
    FROM positions WHERE status IN ('OPEN', 'PARTIAL')
  `).all();
  for (const position of positions) {
    const snapshot = parseSnapshot(position.snapshot_json);
    const initialRisk = Number(position.initial_risk_amount);
    const openLots = Number(position.quantity_open_lots);
    const initialLots = Number(position.quantity_initial_lots);
    if (!positive(initialRisk) || !positive(openLots) || !positive(initialLots) || openLots > initialLots + 1e-8) return null;
    if (currencyOf(snapshot) !== accountCurrency) return null;
    amount += initialRisk * openLots / initialLots;
  }

  const pendingOrders = db.prepare(`
    SELECT quantity_lots, remaining_quantity_lots, snapshot_json
    FROM orders WHERE status IN ('PENDING', 'PARTIAL')
  `).all();
  for (const order of pendingOrders) {
    const snapshot = parseSnapshot(order.snapshot_json);
    const quantity = Number(order.quantity_lots);
    const remaining = Number(order.remaining_quantity_lots);
    const riskAmount = Number(snapshot?.sizing?.riskAmount);
    if (!positive(quantity) || !positive(remaining) || remaining > quantity + 1e-8 || !positive(riskAmount)) return null;
    if (currencyOf(snapshot) !== accountCurrency) return null;
    amount += riskAmount * remaining / quantity;
  }

  return Number((amount / Number(equity) * 100).toFixed(6));
}

export function loadFreshRiskMetrics(db, now = new Date()) {
  const row = db.prepare("SELECT value_json, updated_at FROM app_state WHERE key = 'riskMetrics'").get();
  if (!row) return { freshness: 'UNAVAILABLE', updatedAt: null, ageMs: null, reason: 'RISK_STATE_UNAVAILABLE' };

  let value;
  try { value = JSON.parse(row.value_json); } catch {
    return { freshness: 'INVALID', updatedAt: row.updated_at, ageMs: null, reason: 'RISK_STATE_INVALID' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { freshness: 'INVALID', updatedAt: row.updated_at, ageMs: null, reason: 'RISK_STATE_INVALID' };
  }

  const timestamp = Date.parse(row.updated_at);
  const ageMs = Number.isFinite(timestamp) ? now.getTime() - timestamp : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(timestamp) || ageMs < 0 || ageMs > MAX_RISK_STATE_AGE_MS) {
    return { ...value, freshness: 'STALE', updatedAt: row.updated_at, ageMs, reason: 'RISK_STATE_STALE' };
  }
  if (!positive(value.equity) || typeof value.currency !== 'string' || !value.currency.trim()
    || !finite(value.dailyLossR) || Number(value.dailyLossR) < 0
    || !finite(value.drawdownPct) || Number(value.drawdownPct) < 0) {
    return { ...value, freshness: 'INVALID', updatedAt: row.updated_at, ageMs, reason: 'RISK_STATE_INVALID' };
  }

  const openRiskPct = calculatePaperOpenRiskPct(db, { equity: value.equity, currency: value.currency });
  if (!finite(openRiskPct) || Number(openRiskPct) < 0) {
    return { ...value, freshness: 'INVALID', openRiskPct: null, updatedAt: row.updated_at, ageMs, reason: 'OPEN_RISK_UNAVAILABLE' };
  }
  return {
    ...value,
    openRiskPct,
    freshness: 'FRESH',
    updatedAt: row.updated_at,
    ageMs,
    reason: null,
  };
}
