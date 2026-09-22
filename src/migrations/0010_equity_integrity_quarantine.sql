ALTER TABLE equity_snapshots ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'VALID';
ALTER TABLE equity_snapshots ADD COLUMN accounting_reason TEXT;

CREATE INDEX idx_equity_snapshots_accounting_status_observed_at
  ON equity_snapshots(accounting_status, observed_at DESC);

UPDATE equity_snapshots
SET accounting_status = 'QUARANTINED', accounting_reason = 'REALIZED_PNL_NOT_BACKED_BY_VALID_TRADE'
WHERE ABS(
  CAST(realized_pnl AS REAL) - COALESCE((
    SELECT SUM(CAST(t.net_pnl AS REAL))
    FROM trades t
    WHERE t.accounting_status = 'VALID'
      AND t.closed_at <= equity_snapshots.observed_at
  ), 0)
) > 0.01;
