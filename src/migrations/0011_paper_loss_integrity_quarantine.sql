-- A paper result that loses materially more than its persisted risk budget is
-- retained as raw evidence but must not contaminate equity or performance stats.
-- 1.5R allows a bounded modeled gap/slippage tolerance; it is not a strategy
-- parameter and does not change the configured 0.25% per-trade risk.
UPDATE trades
SET accounting_status = 'QUARANTINED', accounting_reason = 'LOSS_EXCEEDS_PAPER_RISK_TOLERANCE'
WHERE accounting_status = 'VALID'
  AND CAST(net_pnl AS REAL) < 0
  AND json_valid(snapshot_json)
  AND COALESCE(
    CAST(json_extract(snapshot_json, '$.sizing.riskAmount') AS REAL),
    CAST(json_extract(snapshot_json, '$.snapshots.sizing.riskAmount') AS REAL),
    0
  ) > 0
  AND ABS(CAST(net_pnl AS REAL)) > (
    COALESCE(
      CAST(json_extract(snapshot_json, '$.sizing.riskAmount') AS REAL),
      CAST(json_extract(snapshot_json, '$.snapshots.sizing.riskAmount') AS REAL),
      0
    ) * 1.5 + 0.01
  );

-- Re-evaluate previously persisted equity snapshots after the trade quarantine.
-- No rows are deleted and the original evidence remains available for audit.
UPDATE equity_snapshots
SET accounting_status = 'QUARANTINED', accounting_reason = 'REALIZED_PNL_NOT_BACKED_BY_VALID_TRADE'
WHERE accounting_status = 'VALID'
  AND ABS(
    CAST(realized_pnl AS REAL) - COALESCE((
      SELECT SUM(CAST(t.net_pnl AS REAL))
      FROM trades t
      WHERE t.accounting_status = 'VALID'
        AND t.closed_at <= equity_snapshots.observed_at
    ), 0)
  ) > 0.01;
