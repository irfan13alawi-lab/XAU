CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) STRICT;

CREATE TABLE config_versions (
  version TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE broker_health (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE')),
  checked_at TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE TABLE market_snapshots (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('BROKER', 'SYNTHETIC', 'STALE', 'UNAVAILABLE')),
  bid TEXT,
  ask TEXT,
  last TEXT,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE TABLE candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('M15', 'M30', 'H1', 'H4')),
  closed_at TEXT NOT NULL,
  open_price TEXT NOT NULL,
  high_price TEXT NOT NULL,
  low_price TEXT NOT NULL,
  close_price TEXT NOT NULL,
  tick_volume INTEGER,
  source TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, closed_at)
) STRICT;

CREATE INDEX idx_candles_symbol_timeframe_closed
  ON candles(symbol, timeframe, closed_at DESC);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  reason_json TEXT NOT NULL,
  config_version TEXT NOT NULL,
  correlation_id TEXT NOT NULL
) STRICT;

CREATE INDEX idx_scan_runs_started_at ON scan_runs(started_at DESC);

CREATE TABLE timeframe_analyses (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_runs(id),
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT', 'NEUTRAL', 'UNAVAILABLE')),
  strength REAL,
  votes_json TEXT NOT NULL,
  indicators_json TEXT NOT NULL,
  rejection_reasons_json TEXT NOT NULL,
  candle_closed_at TEXT,
  UNIQUE (scan_id, timeframe)
) STRICT;

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_runs(id),
  logical_setup_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  status TEXT NOT NULL,
  entry_price TEXT,
  stop_price TEXT,
  take_profit_1 TEXT,
  take_profit_2 TEXT,
  score REAL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE risk_decisions (
  id TEXT PRIMARY KEY,
  scan_id TEXT REFERENCES scan_runs(id),
  signal_id TEXT REFERENCES signals(id),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  reasons_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  signal_id TEXT REFERENCES signals(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'STOP')),
  status TEXT NOT NULL,
  quantity_lots TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  stop_price TEXT NOT NULL,
  take_profit_1 TEXT NOT NULL,
  take_profit_2 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_orders_status_created
  ON orders(status, created_at DESC);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'PARTIAL', 'CLOSED')),
  quantity_open_lots TEXT NOT NULL,
  quantity_initial_lots TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  mark_price TEXT,
  stop_price TEXT NOT NULL,
  take_profit_1 TEXT NOT NULL,
  take_profit_2 TEXT NOT NULL,
  tp1_hit INTEGER NOT NULL DEFAULT 0 CHECK (tp1_hit IN (0, 1)),
  realized_pnl TEXT NOT NULL DEFAULT '0',
  unrealized_pnl TEXT,
  mfe TEXT NOT NULL DEFAULT '0',
  mae TEXT NOT NULL DEFAULT '0',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  snapshot_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_positions_status_opened
  ON positions(status, opened_at DESC);

CREATE TABLE position_events (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  event_type TEXT NOT NULL,
  old_state TEXT,
  new_state TEXT,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL UNIQUE REFERENCES positions(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  gross_pnl TEXT NOT NULL,
  net_pnl TEXT NOT NULL,
  pnl_r REAL,
  commission TEXT NOT NULL,
  swap TEXT NOT NULL,
  close_reason TEXT NOT NULL,
  setup_quality TEXT,
  market_condition TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  entry_delay_seconds INTEGER,
  mfe TEXT NOT NULL,
  mae TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_trades_closed_at ON trades(closed_at DESC);

CREATE TABLE trade_snapshots (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  snapshot_type TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE news_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  currency TEXT NOT NULL,
  impact TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  reason TEXT NOT NULL,
  config_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  position_id TEXT REFERENCES positions(id),
  entry_type TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL
) STRICT;

CREATE INDEX idx_ledger_entries_occurred_at ON ledger_entries(occurred_at DESC);
