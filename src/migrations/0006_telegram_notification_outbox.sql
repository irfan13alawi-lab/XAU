CREATE TABLE telegram_notification_outbox (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL,
  recipient_fingerprint TEXT NOT NULL CHECK (length(recipient_fingerprint) = 64),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'BOT_ON', 'BOT_OFF', 'SCAN', 'ORDER_PENDING', 'ORDER_PARTIAL', 'ORDER_FILLED',
    'ORDER_EXPIRED', 'ORDER_REJECTED', 'POSITION_TP1', 'POSITION_TP2',
    'POSITION_STOP', 'POSITION_CLOSED', 'RISK_GUARD', 'BROKER_HEALTH',
    'NEWS_STATE', 'DAILY_SUMMARY', 'PAPER_MODE', 'ENTRY_STATE', 'COMMAND_REPLY'
  )),
  message_text TEXT NOT NULL CHECK (length(message_text) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TEXT,
  retry_after_at TEXT,
  last_error_code TEXT CHECK (last_error_code IN (
    'TELEGRAM_REPLY_FAILED', 'TELEGRAM_RATE_LIMITED', 'RECIPIENT_UNAVAILABLE',
    'RECIPIENT_NOT_ALLOWLISTED', 'DELIVERY_RETRY_LIMIT'
  )),
  UNIQUE (event_key, recipient_fingerprint)
) STRICT;

CREATE INDEX idx_telegram_notification_outbox_pending
  ON telegram_notification_outbox (retry_after_at, id)
  WHERE sent_at IS NULL AND (last_error_code IS NULL
    OR last_error_code IN ('TELEGRAM_REPLY_FAILED', 'TELEGRAM_RATE_LIMITED'));
