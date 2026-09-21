ALTER TABLE trades ADD COLUMN review_class TEXT;
CREATE INDEX idx_trades_review_class ON trades(review_class, closed_at DESC);
