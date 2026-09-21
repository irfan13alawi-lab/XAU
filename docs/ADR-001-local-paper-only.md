# ADR-001: Local paper-only runtime

- Status: accepted for the current prototype
- Date: 2026-09-21

## Context

The existing NEXORA workspace is a static dashboard. No broker, market-data source, news calendar, account metadata, deployment runtime, or credentials have been selected. The product brief requires truthful offline behavior and explicitly forbids live trading without separate approval.

## Decision

- Keep the existing dashboard and add a small local Node.js HTTP/API service with built-in SQLite.
- Bind the service to `127.0.0.1`/`localhost`; do not publish or provision external services.
- Bind the loopback port before opening/migrating SQLite. A port conflict must fail before database side effects, preventing a second local process from upgrading the active instance's database while failing to start.
- Use SQLite for the single-process local prototype with migrations, unique idempotency keys, transactions, append-only application audit and configuration-version guards, and tested backup/restore copies.
- Keep market/news provider interfaces separate from the domain. Until an actual provider is selected, use an unavailable provider that fails closed.
- Implement signal/risk/paper execution as deterministic code. There is no live adapter, live SDK, or live order path; `LIVE_TRADING_ENABLED` must remain false.
- Keep the deterministic strategy profile separate from provider/runtime config. Validate indicator votes, timeframe weights, MTF minimums, ATR/target levels, and expiry values; fingerprint the complete profile plus risk policy, store rationale by threshold, and snapshot the effective provider spread threshold on every scan. The logical M15 idempotency key is based on the closed candle—not the config fingerprint—so a policy/config revision cannot create a second scan for that same candle.
- Restore into a new candidate database file; do not overwrite or switch the active database automatically.
- For the current Windows local target, provide an optional current-user Task Scheduler definition with bounded restart retries. Do not register/start it without the owner's explicit local action; it is not a public deployment or Windows service.

## Alternatives considered

- Keep only a static dashboard: rejected because it cannot persist auditable state or execute local tests against API behavior.
- Add a hosted backend/broker integration immediately: rejected because the deployment target and broker have not been chosen and external provisioning is not authorized.
- Add an LLM/agent to decide trades: rejected because the decision path is explicitly testable and must remain deterministic; probabilistic output cannot authorize a financial side effect.

## Engineering reference and evidence

The user's *AI Engineer in 2026* PDF is used only as a production-engineering reference (not as a trading thesis or evidence of profitability). Its themes from idempotency/retries, eval-driven engineering, graceful degradation, incident response, secrets protection, and auditability are reflected in the local design: deterministic side-effect boundaries, replayable tests, explicit offline/read-only behavior, redacted telemetry, append-only application audit, content-versioned strategy/risk manifests with per-threshold rationale, and a release checklist that keeps unproven gates open. Evidence is limited to the local fixture/test scope stated in `docs/RELEASE-CHECKLIST.md`; no synthetic result is treated as market-performance evidence.

### PDF-to-implementation crosswalk

The chapter references below use the printed page numbers in the PDF's table of contents. They identify engineering patterns adapted to this deterministic trading application; AI-agent-specific mechanisms are not imported where the product has no LLM or agent.

| PDF reference | Application in NEXORA | Evidence and boundary |
|---|---|---|
| Ch. 34, *Idempotency, Retries & Work Queues* (p. 351) | Persisted idempotency keys and logical M15 scan identity; paper order/position transitions commit transactionally and replay safely. | `src/database.mjs`, `src/services/paper-lifecycle-service.mjs`, `test/recovery.test.mjs`. This proves local SQLite behavior, not reconciliation with an external broker. |
| Ch. 47, *The Eval-Driven Engineering Mindset* (p. 479); Ch. 48, *Golden Datasets* (p. 489); Ch. 56, *Experiment Tracking & A/B Testing* (p. 565) | Versioned strategy/risk configuration, hashed local research inputs, chronological walk-forward folds, explicit sample sizes, and suppression of synthetic PnL conclusions. | `src/domain/research-evaluation.mjs`, `test/research-evaluation.test.mjs`, `docs/HISTORICAL-EVALUATION.md`. No verified owner dataset, performance baseline, or CI experiment pipeline is present; no strategy edge is established. |
| Ch. 57, *Tracing Agentic Systems* (p. 579); Ch. 58, *Observability with OpenTelemetry* (p. 589) | Request IDs, a separate scan-to-exit correlation ID, bounded worker-cycle/dependency metrics, and redacted low-cardinality request logs. | `src/server.mjs`, `src/worker.mjs`, `test/api.test.mjs`, `test/worker.test.mjs`. This is local observability, not OpenTelemetry or distributed/external tracing. |
| Ch. 63, *Fallback & Graceful Degradation* (p. 635); Ch. 65, *Incident Response for AI* (p. 653) | Provider/news outages hold new entries while read-only state remains available; runbooks cover containment, recovery, and rollback, backed by crash/replay tests. | `src/worker.mjs`, `docs/RUNBOOK.md`, `test/recovery.test.mjs`, `test/worker.test.mjs`. Real provider incidents and operational drills remain unverified. |
| Ch. 68, *Tool & Agent Security* (p. 687); Ch. 69, *Secrets & Data Protection* (p. 697); Ch. 71, *Guardrails & Policy Enforcement* (p. 717); Ch. 73, *Auditability & Compliance* (p. 737) | Deterministic authorization/risk boundaries, a permanently disabled live path, secret redaction, and append-only application audit events. | `src/config.mjs`, `src/server.mjs`, `src/database.mjs`, `test/security.test.mjs`, `test/api.test.mjs`. No LLM/agent execution, tenant model, cryptographic/WORM audit store, or compliance certification is claimed. |
| Ch. 80, *Enterprise Reference Architecture & 90-Day Roadmap* (p. 809) | Separate dashboard/API, domain services, provider contracts, worker, persistence, and telemetry while retaining a small local single-process deployment. | `src/`, `docs/ADR-001-local-paper-only.md`, `docs/RELEASE-CHECKLIST.md`. The architecture is a local prototype, not a production or multi-instance deployment. |

These references guide system engineering only. A PDF chapter, passing software test, or synthetic replay cannot validate XAUUSD profitability or replace broker/provider contract evidence.

## Consequences and limitations

- Node's built-in SQLite keeps the local project dependency-light, but `DatabaseSync` is synchronous and is appropriate only for this single-process prototype. This host's Node v24.14.0 reports SQLite as active development; the official v24.15.0 docs change its status to release candidate, not stable. Runtime and persistence choice must be reviewed before any production or multi-instance use ([Node.js v24.14 SQLite docs](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html), [Node.js v24.15 SQLite docs](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)).
- No live quotes, candles, account equity, contract metadata, news data, broker readiness, or profitability claims can be shown until a provider and its semantics are selected and tested.
- The worker implements provider-neutral ingestion, closed-M15 scan scheduling, paper fill/position lifecycle, and bounded dependencies, but the default adapters are unavailable. Fixture tests do not establish production reliability against an actual data vendor or broker.
- Application-level append-only triggers are not cryptographic/WORM storage and do not by themselves constitute regulatory-grade audit retention.

## Revisit when

The user selects a provider and runtime target, authorizes the exact data/credential scope, and the system has passed vendor adapter contract tests, full worker lifecycle/recovery tests, security review, and sustained paper-forward evaluation. Revisit does not itself authorize live trading.
