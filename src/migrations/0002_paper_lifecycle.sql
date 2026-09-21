ALTER TABLE orders ADD COLUMN remaining_quantity_lots TEXT NOT NULL DEFAULT '0';
UPDATE orders SET remaining_quantity_lots = quantity_lots WHERE status IN ('PENDING', 'PARTIAL');

ALTER TABLE positions ADD COLUMN realized_gross_pnl TEXT NOT NULL DEFAULT '0';
ALTER TABLE positions ADD COLUMN commission_paid TEXT NOT NULL DEFAULT '0';
ALTER TABLE positions ADD COLUMN swap_paid TEXT NOT NULL DEFAULT '0';
ALTER TABLE positions ADD COLUMN initial_risk_amount TEXT NOT NULL DEFAULT '0';
ALTER TABLE positions ADD COLUMN last_swap_at TEXT;
UPDATE positions SET last_swap_at = opened_at WHERE last_swap_at IS NULL;
