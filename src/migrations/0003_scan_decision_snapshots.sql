ALTER TABLE scan_runs ADD COLUMN direction TEXT;
ALTER TABLE scan_runs ADD COLUMN score REAL;
ALTER TABLE scan_runs ADD COLUMN confluence_pct REAL;
ALTER TABLE scan_runs ADD COLUMN decision_snapshot_json TEXT NOT NULL DEFAULT '{}';
