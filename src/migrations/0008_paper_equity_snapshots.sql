CREATE TABLE equity_snapshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('PAPER_SIMULATION', 'BROKER_ACCOUNT')),
  currency TEXT NOT NULL,
  balance TEXT NOT NULL,
  equity TEXT NOT NULL,
  realized_pnl TEXT NOT NULL,
  unrealized_pnl TEXT NOT NULL,
  drawdown_pct REAL,
  observed_at TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_equity_snapshots_observed_at
  ON equity_snapshots(observed_at DESC);
