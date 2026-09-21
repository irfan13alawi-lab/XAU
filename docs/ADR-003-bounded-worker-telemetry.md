# ADR-003: Bounded local worker-cycle telemetry

## Status

Accepted for the single-process local paper prototype.

## Context

The worker exposed only its latest cycle in health/dashboard state. That made latency and classified failures disappear from useful context after a later cycle or process restart. The product brief calls for observable dependency latency, error classes, recovery evidence, and low-cardinality telemetry. This prototype has no selected production runtime or external observability provider, and it must not store provider payloads or credentials in telemetry.

## Decision

Persist one normalized row per completed or safely failed worker cycle in SQLite. Store only UTC observation time, bounded cycle/dependency durations, allowlisted dependency statuses, and a fixed error class. Keep seven days of history with an approximately 60,000-row hard bound; prune on the first cycle, every 64 cycles, and while near capacity. Expose aggregate 1-hour/24-hour p50/p95/max latency, worker failure count/rate, and dependency attempt/failure/status summaries through a read-only local endpoint. The dashboard shows the one-hour sample count, p95, and failed-cycle count.

Telemetry is diagnostic only: it is not audit evidence, a broker execution measurement, an SLO/alerting system, external tracing, or strategy-performance evidence. It does not gate paper entries by itself. If writing telemetry fails during a successful worker cycle, the cycle follows the existing safe worker-failure path and entries remain paused; raw error text is not retained.

## Alternatives considered

- Keep only the last-cycle snapshot: simplest, but loses trend and restart context.
- Add an external metrics/tracing service: requires provider selection, networking, credentials, and operational/privacy decisions not authorized for this local prototype.
- Store every request/dependency payload: rejected because it increases sensitivity, cardinality, and retention risk without helping the paper readiness decision.

## Consequences

- A migration adds a strict, indexed table; status/error enums and numeric bounds constrain what can be persisted.
- Dashboard and API can distinguish a transient slow/failing cycle from a sustained local worker trend while the app is running or after restart.
- SQLite write volume increases by one small row per worker cycle. Seven-day/row-count pruning bounds local growth.
- Percentiles describe only retained local worker samples and must not be interpreted as market-feed or order-fill latency.

## Evidence and review conditions

API tests verify window filtering, percentile calculation, per-dependency summaries, and payload exclusion. Worker tests verify healthy/offline and classified failure recording; retention tests verify age pruning and the row bound. Migration tests cover fresh schema and additive upgrade from v5 while preserving audit/outbox data. Revisit this decision before multi-process operation, production deployment, or a requirement for alerting/SLOs, longer retention, request-level time series, or distributed tracing.
