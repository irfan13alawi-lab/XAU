# NEXORA XAU Forex Auto Trading

Local-first XAUUSD analysis and paper-trading terminal. This workspace has **no live order adapter** and does not send live orders. It can consume a read-only Twelve Data XAU/USD feed while all execution remains paper-only.

## Requirements and run

- Node.js 24.14 or later (the current implementation uses Node's built-in `node:sqlite`).
- PowerShell from the project directory:

```powershell
Copy-Item .env.example .env
npm test
npm start
```

Open `http://127.0.0.1:18765`. The host is loopback-only. Keep `LIVE_TRADING_ENABLED=false`; the app exits if another value is supplied. The current runtime may print Node's experimental SQLite warning; this prototype should stay local until the runtime/database choice is reviewed.

The dashboard and `/healthz` identify the loaded app build. The service derives a stable `LOCAL-<hash>` from the package manifest, application source, and built dashboard assets; there is no runtime override, and `.env`, credentials, and database contents are not part of the hash.

The dashboard can run in tokenless operator mode when `NEXORA_CONTROL_TOKEN` is blank: the control field is hidden and same-origin dashboard actions are available without an unlock step. This is intended only for a private/local or separately protected deployment; anyone who can reach the dashboard can request pause/resume/scan/paper controls. For a public endpoint, set `NEXORA_CONTROL_TOKEN` to a newly generated random value of at least 32 characters; the page keeps it in memory only and sends it only to this API, never to browser storage or logs. Never paste the token into chat or commit `.env`.

## What is implemented

- Existing dark NEXORA dashboard connected to local JSON API; unavailable values are not replaced with sample prices/balances.
- Local Node HTTP service, SQLite migrations, append-only application audit/configuration versions, persistent operator actions, content-versioned strategy manifests, end-to-end paper lifecycle correlation IDs, idempotency, health/readiness split, and a non-overlapping worker with provider deadlines.
- Worker-cycle diagnostics retained locally for seven days (capped at 60,000 samples), with low-cardinality dependency status/duration, cycle p50/p95, and failure summaries; provider payloads and source labels are not stored in telemetry.
- Deterministic EMA/RSI/MACD/ATR/ADX/Stoch RSI/Supertrend and price-structure helpers; MTF data-quality checks, gate, explainable rejection reasons, news/risk guards, contract-aware paper sizing.
- Strategy/voting/entry-plan parameters are injected into the domain, validated against safety floors, and content-fingerprinted with per-threshold rationales; every persisted scan stores its effective config manifest. Logical once-per-closed-M15 idempotency is independent of that config fingerprint.
- A persistent paper lifecycle: provider-agnostic quote/candle/news ingestion contracts, once-per-new-closed-M15 scans, bid/ask order matching, partial fills, TP1/TP2/SL/expiry/manual close, ledger/trade snapshots, and duplicate replay protections.
- Paper matching enforces explicit entry latency and fill-ratio assumptions, applies fixed adverse slippage to market/stop exits, caps TP exits at their limit prices, applies each partial fill once per increasing quote timestamp, respects minimum-lot steps, and protects minimum-lot positions at TP1 without inventing an impossible partial close.
- Same-origin controls for pause/resume, scan, paper ON/OFF, and manual paper-position close, with optional bearer-token authentication. Manual close requires a fresh accepted market quote and records `MANUAL_CLOSE` through the same transactional journal/audit path; it cannot send a live order. Paper OFF cancels unfilled paper quantity, preserves open-position monitoring, and cannot be undone by a restart; enabling paper leaves entries paused.
- A persisted trade-review journal with objective setup/market tags, realized periods, drawdown in R, fills/duration/MAE/MFE, exits, and cohort slices. Interpretive metrics stay hidden below 30 closed trades; money metrics are also hidden when account currency is unavailable or mixed.
- Verified closed-market candle chart API for M15/M30/H1/H4, EMA/ATR/volume/volatility context, 24-hour XAU overview, explicit spot-derivative `N/A` fields, latest stored MTF decision evidence, and a news-calendar status endpoint. Empty feed means an empty chart—not demo price action.
- Validated consistent SQLite backup and restore-to-new-candidate commands.
- Offline chronological walk-forward research replay using the same local worker and paper lifecycle, with dataset hashing, anti-look-ahead checks, quote-gap/scan-coverage disclosure, and synthetic-result suppression.
- Optional Telegram command bridge and event/daily-summary notification outbox, disabled by default and covered by mocked delivery tests only.
- Optional, unregistered Windows Task Scheduler configuration for current-user logon and bounded restart attempts; it does not enable itself or start the server during registration.

Architecture choices and their review conditions are recorded in [ADR-001](docs/ADR-001-local-paper-only.md) and [ADR-002](docs/ADR-002-telegram-outbox.md).

## Deliberately unavailable

- No live broker has been selected or connected; there are no broker credentials or contract metadata. No account balance, equity, news calendar, or live PnL is present. A read-only market-data provider can supply quote/candle observations without enabling trading.
- The default installation has no provider configured. Set `NEXORA_MARKET_SOURCE=twelvedata`, provide `NEXORA_TWELVEDATA_API_KEY`, and explicitly set `NEXORA_PAPER_SPREAD_PRICE` to enable the read-only XAU/USD feed. Twelve Data supplies the mid-price; the configured spread is a paper assumption and is never presented as an observed broker spread.
- The dashboard market contract is served by `server.js` on the VPS: the browser reads `/api/market` and `/api/dashboard`, while provider credentials and upstream calls stay on the VPS. The XAU overview reports 24-hour change/high/low from closed M15 bars and clearly labels provider tick volume; spot XAU/USD has no single consolidated exchange volume, funding rate, or open interest.
- The persistent paper lifecycle is implemented and tested against deterministic fixtures; fixture tests are not evidence of real-market fill quality or strategy performance.
- No configured Telegram bot/provider, public hosting, or live execution path. Telegram commands and notifications remain disabled unless separately configured and explicitly authorized.
- Nothing in the included synthetic tests establishes strategy profitability.

## Offline historical evaluation

Prepare a vendor-sourced JSON dataset using the contract in [docs/HISTORICAL-EVALUATION.md](docs/HISTORICAL-EVALUATION.md), calculate its canonical digest, then run:

```powershell
npm run research-hash -- .\data\xau-history.json
npm run evaluate -- .\data\xau-history.json --fold-count 3 --training-fraction 0.70 --minimum-training-bars 100
```

Evaluation accepts owner-classified broker history only; it never connects to a provider. Reports are created without overwriting prior runs under `data/research-results/`. The current workspace has no approved historical dataset, so no strategy baseline has been evaluated. Owner-supplied provider/account data is not independently verified, large quote gaps require review, and historical results are not a profitability claim.

## Useful endpoints

- `GET /healthz` — liveness, readiness reasons, DB/worker/provider state, latest-cycle diagnostics, and retained one-hour worker telemetry.
- `GET /api/telemetry/worker?window=1h|24h` — bounded aggregate cycle/dependency p50/p95/error summaries from local SQLite; no raw provider payloads, request samples, external tracing, or broker execution measurements.
- `GET /api/dashboard`, `/bot/status`, `/api/market`, `/api/market/overview`, `/api/market/candles?timeframe=M15|M30|H1|H4`, `/api/mtf/latest`, `/api/news`, `/api/positions`, `/api/orders`, `/api/trades?limit=25&cursor=...`, `/api/stats`, `/api/audit`, `/api/scan/latest`.
- `/api/trades` returns paginated lean journal rows by default; add `details=true` for a bounded page containing the stored snapshot. Trades whose observed loss exceeds the paper risk-integrity tolerance remain retained but are marked `QUARANTINED` and excluded from equity/statistics.
- `POST /api/actions/pause`, `/resume`, `/scan`, `/paper`, `/close` require same-origin and an `Idempotency-Key`; a configured `Authorization: Bearer` operator token is optional. When `NEXORA_CONTROL_TOKEN` is set, wrong or missing tokens return `401 CONTROL_AUTH_REQUIRED`. `/paper` accepts `{ "enabled": true|false }`; `/close` accepts only `{ "positionId": "..." }` and fails closed unless that paper position is open and a fresh verified broker quote plus cost assumptions are available. Resume remains blocked unless paper mode and readiness checks are both on.

## Tests and checks

```powershell
npm run test:smoke
npm run test:unit
npm run test:integration
npm run test:recovery
npm run test:security
npm test
npm run check
```

The tests cover API auth/CSRF and fail-closed behavior, live-mode startup rejection and paper-adapter capability limits, indicators and warm-up, stale/look-ahead/synthetic rejection, MTF/risk/news gates, paper bid/ask fills and persistent position lifecycle, manual-close quote checks and transactional journaling, partial-fill replay/idempotency, TP1 remainder cancellation, paper-OFF cancellation/monitoring, trade-review aggregation and 30-trade interpretation threshold, worker timeout/overlap/malformed data/database failure/redaction, once-per-candle scans, append-only audit, abrupt process-kill recovery across full and partial fill, TP1, remainder cancel, TP2 and manual close, expiry, and paper-off transactions, persistence/reopen, backup/restore integrity, a high-confidence credential-literal scan, and the in-memory walk-forward harness. Synthetic harness runs are software tests only. No verified dataset or strategy-performance result is present.

These commands separate fast API/startup smoke checks, domain unit tests, integration tests, process-crash recovery, and a high-confidence credential-literal scan. Paper-forward evaluation is a separate owner-reviewed evidence gate; it requires a selected real provider and is not replaced by synthetic fixtures or the walk-forward software test.

## Backup and restore candidate

With the local service/database available, create a consistent backup:

```powershell
npm run backup
```

Validate and copy a chosen backup into a new candidate file, without replacing the active DB:

```powershell
npm run restore -- backups\nexora-backup-<timestamp>-<id>.sqlite
```

The restore utility writes under `data/restore-candidates/` and runs SQLite integrity and foreign-key checks. It does **not** switch the running service to the candidate. Stop the service, verify the candidate and config path, and make an additional backup before any manual recovery cutover. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Safety status

`LIVE_TRADING_ENABLED=false` is an invariant. No number of passing tests or paper trades unlocks live trading. Before realistic paper-forward operation, the owner must select and authorize a market/news provider and supply verified XAUUSD contract/account metadata. Those decisions are intentionally unresolved; no broker, market feed, news source, or credential has been chosen on the owner's behalf.

See [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md) for evidence status and owner-gated release criteria. The checklist is never an activation switch.
