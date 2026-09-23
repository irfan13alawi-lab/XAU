# NEXORA local operations runbook

This runbook is for the local paper-only prototype. It does not authorize live trading, broker orders, or public deployment.

## Start and verify

The dashboard refreshes read-only status every 15 seconds. Each API request has an 8-second deadline; if one stalls, the page reports a timeout and releases its refresh lock so a later cycle can retry. A normal page refresh does not trigger a scan. A timeout does not prove that a state-changing action was not accepted; check the resulting state before repeating a consequential action.

1. Copy `.env.example` to `.env` if needed. Leave `NEXORA_CONTROL_TOKEN` blank for tokenless operator mode, or set it to a newly generated random secret of at least 32 characters using a local secret manager for a public deployment. Do not paste it into chat or commit `.env`.
2. In PowerShell at the project directory, run `npm start`.
3. Open `http://127.0.0.1:18765`. In tokenless mode, controls are immediately available; when a token is configured, enter it in the local operator-control field. A configured token is kept in page memory only and must be re-entered after reload.
4. Check `http://127.0.0.1:18765/healthz`, `/api/dashboard`, and `/api/telemetry/worker?window=1h`. `worker.lastTick` gives the most recent cycle; the telemetry endpoint aggregates persisted cycle/dependency latency and failures for 1h or 24h. `attempted: false` means a dependency was skipped or served from cache, so it is excluded from that dependency's latency percentile. Metrics are local diagnostics retained for at most seven days/60,000 samples; they are not external tracing, broker fill latency, or strategy evidence.
5. Confirm `liveTradingEnabled` is false and the UI accurately shows broker/data unavailable when no provider is configured.

Each HTTP response includes an `X-Request-ID`. Local request logs are JSON lines with that ID, a low-cardinality route label, method, status, and duration; query strings, request bodies, and authorization headers are not logged. Mutating API audit metadata records `httpRequestId`, linking the first request that executed an idempotent action to its request log. A later replay gets a new HTTP request ID but does not duplicate the audit event. These request IDs are distinct from the persisted trade-lifecycle `correlationId`, which links a scan through its order/position events.

`liveness: ok` means the process responds. `readiness: not_ready` is expected without a selected and healthy market provider. Never infer trading readiness from process liveness or a green UI alone.

Every mutating API endpoint requires same-origin plus an idempotency key. Bearer-token authentication is optional when `NEXORA_CONTROL_TOKEN` is blank and enforced when it is configured. The dashboard never persists a configured token and does not send it to any third-party host.

## Optional Windows auto-start

The current supported target is the owner's interactive Windows session, not a public host or Windows service. The optional Task Scheduler registration script is provided but is **not installed or run automatically**. Review it and preview the intended action with `./ops/windows/Register-NexoraPaperTask.ps1 -WhatIf`; this prints the plan but does not ask Task Scheduler to validate or register it. Only if you explicitly want auto-start should you run the script without `-WhatIf` and confirm its prompt. It is intended to register `NEXORA Local Paper Dashboard` for the next interactive logon, under the current user with limited privileges, using the project directory as its working directory; it refuses to overwrite a same-named task, does not start the server immediately, and requests at most three one-minute retries after an unexpected exit. It contains no credential and remains loopback/paper-only. **On the current managed host, Task Scheduler object creation returned `Access denied`; registration and startup have not been verified. Do not bypass that restriction or elevate merely to install this optional task.** Remove an installed task through Task Scheduler if it is no longer wanted.

This is an optional local convenience, not production deployment or a guarantee of uninterrupted operation. The task runs only after that user logs on; Windows sleep, account state, disk failure, and SQLite's single-process/local-storage limits still apply. Review status with Task Scheduler and `/healthz`. The task settings/action follow Microsoft's [`Register-ScheduledTask`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask), [`New-ScheduledTaskAction`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskaction), [`New-ScheduledTaskPrincipal`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal), and [`New-ScheduledTaskSettingsSet`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset) references.

Paper mode controls are deliberately separate from pause/resume. Turning paper mode off pauses entries and cancels all unfilled paper order quantity while continuing to monitor open paper positions when fresh verified quotes are available. Turning paper mode back on does not resume entries. A process restart also forces entries paused and preserves the stored paper ON/OFF state. Neither state enables live trading.

## Optional Telegram command bridge

The Telegram bridge is disabled by default. Enabling it creates an outbound long-poll connection to Telegram, so do not set NEXORA_TELEGRAM_ENABLED=true until that external connection is explicitly approved. Keep the bot token in the local ignored .env/secret store only; never paste it into the dashboard, chat, source control, or logs. Set NEXORA_TELEGRAM_BOT_TOKEN, NEXORA_TELEGRAM_ALLOWED_USER_IDS, and NEXORA_TELEGRAM_ALLOWED_CHAT_IDS; `NEXORA_CONTROL_TOKEN` remains optional. Both allowlists are required and both the sender user ID and destination chat ID must match. Command replies use a local durable outbox even when event notifications are off. Restart the local service after changing environment values.

Supported commands are /status, /positions, /pending, /stats, /lastscan, /pause, /resume, /paper on|off, /scan, and /research <dataset.json>. Every mutating command is sent through the existing authenticated local API with an update-derived idempotency key; resume remains subject to all normal fail-closed readiness checks. There is no live-trading command or route. /research accepts only the same bounded local dataset filename as the dashboard. Telegram state exposes only enabled/configured flags, status, timestamps, and reason codes—never the token or allowlist IDs.

Optional event and daily-summary delivery is separately disabled by default. Only after explicitly authorizing the external Telegram connection, set NEXORA_TELEGRAM_NOTIFICATIONS_ENABLED=true and choose NEXORA_TELEGRAM_DAILY_SUMMARY_UTC_HOUR (0–23; default 0). Summaries cover the prior completed UTC day. The SQLite outbox stores fixed, redacted message text and a salted recipient fingerprint rather than the raw allowlist chat ID; after successful delivery, message content is replaced by a marker, and permanent delivery failures also discard the content. Delivery is rate-limited and transient failures are retried with a bounded attempt count. This is at-least-once delivery: if Telegram accepts a message just before a process crash, it may be sent again after restart. A chat removed from the allowlist will not receive its queued messages. The dashboard shows the notification switch and pending count. The outbox is not an emergency alerting SLA.

The integration uses long polling and will not remove or replace an existing Telegram webhook. If Telegram reports a webhook conflict, the dashboard reports WEBHOOK_CONFIGURED; resolve that configuration intentionally outside this service before enabling long polling. Do not test with a real bot until a token and the exact user/chat allowlists have been configured and the outbound Telegram connection is authorized. Command, notification, retry, and daily-summary tests use mocked Bot API responses only; no real Bot API request has been made.

Paper matching accepts only a complete cost model, including non-negative `fillLatencyMs` (0–120,000 ms), slippage, commission, swap, fill ratio, contract size, quote conversion, lot constraints, break-even offset, and account currency. Pending entries require a fresh quote observed at or after `createdAt + fillLatencyMs`; earlier quotes are held. Each partial-entry allocation is applied at most once per strictly increasing quote-observation timestamp. `fillRatio` is a target allocation per new observation, rounded down to the lot step but up to the minimum executable lot when necessary; the order remainder is never silently stranded below the configured minimum. The fixed `slippagePrice` is adverse on market/stop exits and manual closes. TP1/TP2 limit exits are constrained not to fill worse than the target limit. Exit latency and variable gap/slippage distributions are not modeled; position exits use the first fresh worker quote that reaches the relevant level. These are deterministic paper assumptions, not measured broker fill behavior. The model is captured in order/trade snapshots; no default costs or account values are fabricated.

At TP1, the engine closes half the initial position when the result is a valid executable lot, with the target limit protecting the modeled exit from filling below TP1. If a minimum-lot position cannot be split safely, it records TP1, moves the full remaining position's stop to the configured break-even offset, and cancels the unfilled order remainder in the same transaction; it does not invent a sub-minimum close.

The optional normalized market payload `riskMetrics` must contain `equity` (> 0), `currency` (ISO-style uppercase currency code), `dailyLossR` (finite and >= 0), `drawdownPct` (finite and >= 0), and `observedAt` (the source observation time). `maxSpreadPrice` may be supplied only when verified and must be > 0. Risk observations older than 30 seconds, future-dated, malformed, or missing are not eligible for entries. The adapter must derive these values from the same broker account used for XAUUSD; the application recomputes combined open risk from stored open positions and pending-order sizing, rather than trusting a provider-supplied `openRiskPct`. Every pending fill rechecks freshness and risk limits. A missing risk payload does not refresh an earlier value; that value naturally becomes stale and fills remain held.

## Trade journal interpretation

- `/api/stats` and Trade Journal are derived only from persisted closed paper trades. The UI withholds performance and cohort metrics until a group has at least 30 closed records; each cohort has its own count and threshold.
- If account-currency context is missing or mixed, money totals and related metrics stay hidden rather than combining unlike currencies. R-based daily loss remains separately reported.
- `PAPER_HISTORY_ONLY_NOT_PROFITABILITY_EVIDENCE` is a scope label, not a claim of predictive validity. Paper fills and fixture outcomes do not establish real execution quality or expected returns.
- Spread/ATR bands and setup/market cohorts are descriptive review cuts. They are not automatic parameter optimizers, strategy changes, or entry gates.
- Review the stored entry/TP1/close snapshots and event history for a cohort before drawing a manual research hypothesis; validate any proposed rule on untouched out-of-sample data before changing versioned configuration.

## Pause entries

The current system starts paused and has no live action path. For an idempotent local pause request:

```powershell
$headers = @{ 'Idempotency-Key' = 'ops-pause-20260921-01' }
Invoke-RestMethod -Uri 'http://127.0.0.1:18765/api/actions/pause' -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
```

Use a fresh key for a new operation. `resume` is expected to be rejected unless provider readiness is healthy; do not bypass that response. A new entry should remain blocked whenever market/news/risk status is missing, stale, or ambiguous.

## Close an open paper position

Use the dashboard's `Close paper` control only after authenticating local operator controls and reviewing the position ID. The control stays disabled unless the latest XAUUSD quote is a fresh, verified broker quote. Confirming uses bid for LONG or ask for SHORT as the reference, applies the stored adverse paper slippage/commission/swap assumptions, writes the trade snapshot/ledger/audit event, and cancels any unfilled remainder. It is paper-only and cannot send a live order. If the quote or cost model is unavailable, the request is rejected; do not substitute a displayed, cached, or synthetic price. Verify the resulting close reason and audit correlation in the trade journal before treating the position as closed.

## Broker/feed or news outage

- Keep the system in `BROKER OFFLINE`, `DATA STALE`, `NEWS UNAVAILABLE`, or `ENTRY PAUSED` as appropriate.
- Do not replace missing data with fixture/demo values or switch to an unverified source.
- Preserve the last known persisted state and its timestamp; do not claim it is current.
- Record the correlation/scan ID and reason codes. Restore only after the selected adapter passes source, freshness, schema, clock, and contract-metadata checks.

## Risk guard trip or duplicate intent

- Leave entry paused; do not lower risk limits or remove idempotency records to force an order.
- Inspect latest scan reasons, audit events, `scan_runs`, `orders`, and `positions` for the logical setup key and correlation ID.
- If order/position state is uncertain, treat it as reconciliation-required. Do not retry a side effect speculatively.
- Preserve relevant config/strategy version and database backup before recovery edits. Add a regression test for every confirmed incident cause.

## Database corruption or recovery

The automated recovery suite includes abrupt child-process exits inside local transactions for fill, TP1, TP2 close, manual close, expiry, and `PAPER OFF` cancellation. It checks the audit, position, order, signal, position-event, ledger, trade, and snapshot writes, then verifies one recovery transition after restart. Direct-SL and SL-after-TP1 closure branches are also interrupted at the final net-ledger write and replayed once. This is local SQLite atomicity evidence only; it does not test external broker reconciliation or all partial-fill/remainder-cancel paths. To run it without touching the active dashboard database:

```powershell
node --test test/recovery.test.mjs
```

On an actual unexpected restart, the service forces `ENTRY PAUSED`; verify `/healthz`, order/position counts, audit continuity, and broker/data/news state before any authorized paper resume. Do not manually delete audit events or retry an uncertain external side effect.

The service binds its loopback port before opening or migrating SQLite. If startup reports `PORT_IN_USE`, inspect the existing local process and its `/healthz`; do not launch another instance against the same database or remove a lock/state file to force startup.

Create a consistent backup:

```powershell
npm run backup
```

Restore a chosen backup to a new, validated candidate file (this does not replace the active database):

```powershell
npm run restore -- backups\nexora-backup-<timestamp>-<id>.sqlite
```

The command reports the candidate path and SQLite integrity/foreign-key validation. Before any manual cutover:

1. Pause entries and stop the service cleanly.
2. Make another backup of the current database and keep the original untouched.
3. Confirm the candidate was created from the intended backup; inspect schema migration version and expected records.
4. Point `NEXORA_DB_PATH` in the local environment to the candidate path and start the service only for read-only verification.
5. Check `/healthz`, dashboard state, scan/order/position counts, audit continuity, and `PRAGMA foreign_key_check`/integrity results.
6. Keep the prior DB and backup until recovery is reviewed. Do not delete audit events as part of rollback.

If any state cannot be reconciled, stop at `ENTRY PAUSED` and request owner review. Do not overwrite the active database automatically.

## Current operational boundaries

- No broker or market/news provider is configured. The provider-neutral worker contract exists, but default adapters remain unavailable and provide no real data.
- With an authorized, verified provider implementation, the worker is designed to ingest normalized quotes/candles/news, scan a newly closed M15 candle once, match paper orders, expire orders, and reconcile positions. These behaviors are covered with deterministic provider fixtures only; they are not yet verified against a real vendor or broker feed.
- Resume is fail-closed unless worker, broker health, quote freshness, and news freshness all pass. Even a successful resume would only permit evaluation of paper entries; live trading is absent and readiness does not prove strategy profitability.
- SQLite is for the current local single-process prototype, not a claim of multi-instance production safety.
- Telegram commands and optional event/daily-summary notifications are implemented with mocked tests, but remain disabled until locally configured and the outbound connection is explicitly authorized. Public hosting and live execution are not enabled.
