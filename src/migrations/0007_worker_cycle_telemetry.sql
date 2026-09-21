CREATE TABLE worker_cycle_metrics (
  id INTEGER PRIMARY KEY,
  observed_at TEXT NOT NULL,
  duration_ms REAL CHECK (duration_ms IS NULL OR (duration_ms >= 0 AND duration_ms <= 600000)),
  error_class TEXT CHECK (error_class IS NULL OR error_class IN (
    'DEPENDENCY_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_IOERR',
    'BROKER_REJECTED', 'RATE_LIMITED', 'TYPE_ERROR', 'UNCLASSIFIED'
  )),
  broker_health_attempted INTEGER NOT NULL CHECK (broker_health_attempted IN (0, 1)),
  broker_health_duration_ms REAL CHECK (broker_health_duration_ms IS NULL OR (broker_health_duration_ms >= 0 AND broker_health_duration_ms <= 600000)),
  broker_health_status TEXT NOT NULL CHECK (broker_health_status IN (
    'HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED'
  )),
  market_data_attempted INTEGER NOT NULL CHECK (market_data_attempted IN (0, 1)),
  market_data_duration_ms REAL CHECK (market_data_duration_ms IS NULL OR (market_data_duration_ms >= 0 AND market_data_duration_ms <= 600000)),
  market_data_status TEXT NOT NULL CHECK (market_data_status IN (
    'HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED'
  )),
  news_calendar_attempted INTEGER NOT NULL CHECK (news_calendar_attempted IN (0, 1)),
  news_calendar_duration_ms REAL CHECK (news_calendar_duration_ms IS NULL OR (news_calendar_duration_ms >= 0 AND news_calendar_duration_ms <= 600000)),
  news_calendar_status TEXT NOT NULL CHECK (news_calendar_status IN (
    'HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE', 'SKIPPED', 'NO_DATA', 'TIMEOUT', 'ERROR', 'CACHED', 'NOT_ATTEMPTED'
  ))
) STRICT;

CREATE INDEX idx_worker_cycle_metrics_observed_at
  ON worker_cycle_metrics(observed_at DESC);
