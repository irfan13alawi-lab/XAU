-- Persist worker stage timing so latency regressions can be attributed to a
-- local stage instead of being mistaken for a provider/network failure.
ALTER TABLE worker_cycle_metrics ADD COLUMN health_ms REAL
  CHECK (health_ms IS NULL OR (health_ms >= 0 AND health_ms <= 600000));
ALTER TABLE worker_cycle_metrics ADD COLUMN market_data_ms REAL
  CHECK (market_data_ms IS NULL OR (market_data_ms >= 0 AND market_data_ms <= 600000));
ALTER TABLE worker_cycle_metrics ADD COLUMN news_ms REAL
  CHECK (news_ms IS NULL OR (news_ms >= 0 AND news_ms <= 600000));
ALTER TABLE worker_cycle_metrics ADD COLUMN scan_ms REAL
  CHECK (scan_ms IS NULL OR (scan_ms >= 0 AND scan_ms <= 600000));
ALTER TABLE worker_cycle_metrics ADD COLUMN execution_ms REAL
  CHECK (execution_ms IS NULL OR (execution_ms >= 0 AND execution_ms <= 600000));
ALTER TABLE worker_cycle_metrics ADD COLUMN accounting_ms REAL
  CHECK (accounting_ms IS NULL OR (accounting_ms >= 0 AND accounting_ms <= 600000));
