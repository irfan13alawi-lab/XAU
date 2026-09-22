import { randomUUID } from 'node:crypto';
import { config } from '../config.mjs';

const SNAPSHOT_INTERVAL_MS = 60_000;

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function round(value) {
  return Number(numeric(value).toFixed(8));
}

function latestPeak(db, equity) {
  const row = db.prepare("SELECT MAX(CAST(equity AS REAL)) AS peak FROM equity_snapshots WHERE source = ? AND accounting_status = 'VALID'").get('PAPER_SIMULATION');
  return Math.max(numeric(row?.peak), numeric(equity));
}

export function latestPaperEquitySnapshot(db) {
  const row = db.prepare(`
    SELECT id, source, currency, balance, equity, realized_pnl, unrealized_pnl, drawdown_pct, observed_at, details_json
    FROM equity_snapshots WHERE accounting_status = 'VALID' ORDER BY observed_at DESC LIMIT 1
  `).get();
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    currency: row.currency,
    balance: Number(row.balance),
    equity: Number(row.equity),
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    drawdownPct: row.drawdown_pct == null ? null : Number(row.drawdown_pct),
    observedAt: row.observed_at,
    details: JSON.parse(row.details_json),
  };
}

export function capturePaperEquitySnapshot(db, now = new Date(), { force = false } = {}) {
  if (config.paperStartingEquity == null) return null;
  const latest = db.prepare("SELECT observed_at, accounting_status FROM equity_snapshots WHERE source = ? ORDER BY observed_at DESC LIMIT 1").get('PAPER_SIMULATION');
  const latestAt = Date.parse(latest?.observed_at ?? '');
  if (!force && latest?.accounting_status === 'VALID' && Number.isFinite(latestAt) && now.getTime() - latestAt < SNAPSHOT_INTERVAL_MS) return latestPaperEquitySnapshot(db);

  const realizedPnl = numeric(db.prepare("SELECT COALESCE(SUM(CAST(net_pnl AS REAL)), 0) AS total FROM trades WHERE accounting_status = 'VALID'").get()?.total);
  const unrealizedPnl = numeric(db.prepare("SELECT COALESCE(SUM(CAST(unrealized_pnl AS REAL)), 0) AS total FROM positions WHERE status IN ('OPEN', 'PARTIAL')").get()?.total);
  const balance = config.paperStartingEquity + realizedPnl;
  const equity = balance + unrealizedPnl;
  const peak = latestPeak(db, equity);
  const drawdownPct = peak > 0 ? Math.max(0, (peak - equity) / peak * 100) : null;
  const observedAt = now.toISOString();
  db.prepare(`
    INSERT INTO equity_snapshots (
      id, source, currency, balance, equity, realized_pnl, unrealized_pnl, drawdown_pct, observed_at, details_json
    ) VALUES (?, 'PAPER_SIMULATION', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), config.paperCurrency, String(round(balance)), String(round(equity)), String(round(realizedPnl)), String(round(unrealizedPnl)),
    drawdownPct == null ? null : Number(drawdownPct.toFixed(8)), observedAt,
    JSON.stringify({ startingEquity: config.paperStartingEquity, calculation: 'starting equity + persisted realized and unrealized paper PnL', liveTradingEnabled: false }),
  );
  return latestPaperEquitySnapshot(db);
}
