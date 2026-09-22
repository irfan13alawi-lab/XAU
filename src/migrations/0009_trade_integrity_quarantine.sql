ALTER TABLE trades ADD COLUMN accounting_status TEXT NOT NULL DEFAULT 'VALID';
ALTER TABLE trades ADD COLUMN accounting_reason TEXT;

CREATE INDEX idx_trades_accounting_status_closed_at
  ON trades(accounting_status, closed_at DESC);

-- Preserve the raw trade and its evidence, but exclude a trade whose persisted
-- exit quote explicitly belongs to another symbol from account/statistics.
-- This repairs the known pre-scope-reconciliation corruption without deleting
-- history or rewriting the observed PnL evidence.
UPDATE trades
SET accounting_status = 'QUARANTINED', accounting_reason = 'EXIT_QUOTE_SYMBOL_MISMATCH'
WHERE json_valid(snapshot_json)
  AND json_extract(snapshot_json, '$.exit.quote.symbol') IS NOT NULL
  AND UPPER(CAST(json_extract(snapshot_json, '$.exit.quote.symbol') AS TEXT)) <> UPPER(symbol);
