# ADR-002: Durable, opt-in Telegram delivery

- Status: accepted for the local paper-only prototype
- Date: 2026-09-21

## Context

The product brief makes Telegram optional and requires allowlisted controls, redacted lifecycle alerts, and a daily summary. A direct send after handling a command can lose its reply if the process exits, while retrying the Telegram update may repeat a control action. Persisting every raw audit event or chat identifier would retain unnecessary details.

## Decision

- Keep both the Telegram bridge and notifications disabled by default. No Bot API request is made unless the owner locally configures the bridge; event/daily notifications have a separate opt-in switch.
- Use long polling only. The service does not create, delete, or replace a webhook. Both the Telegram sender ID and destination chat ID must match local allowlists.
- Route state-changing commands through the authenticated loopback API with an update-derived idempotency key. Persist the command reply in the SQLite outbox in the same transaction as the processed-update offset, so redelivery does not re-run a completed action merely to recover a reply.
- Translate allowlisted audit event types into fixed, redacted messages. Never forward raw audit metadata, provider payloads, or credentials. Store a salted fingerprint of the recipient, not its raw ID.
- Use bounded retries only for transient delivery failures and respect Telegram's retry delay. Mark successful delivery by update ID and recipient fingerprint, but do not claim exactly-once external delivery: a process crash after Telegram accepts a message and before the local success marker can cause a duplicate.
- Replace message bodies with `[DELIVERED]` after successful delivery and `[DISCARDED]` after permanent recipient/retry failure. Pending bodies remain locally available only while delivery can still be retried.
- Date daily paper summaries in UTC and calculate them through the end of the completed UTC day. They remain explicitly descriptive and are not a forecast or strategy validation.

## Alternatives considered

- Send replies inline without persistence: rejected because transient failures lose command results and create ambiguity after retries.
- Claim exactly-once Telegram delivery: rejected because the remote send and local SQLite marker cannot share one transaction or idempotency protocol.
- Forward raw audit events: rejected because metadata may contain internal identifiers or provider-derived data that should not leave the local system.

## Consequences and evidence

- Migration 0006 adds a constrained outbox with a retry index. A v5-to-v6 migration test verifies prior audit rows remain intact and SQLite integrity/foreign-key checks pass.
- Mock tests cover disabled-by-default behavior, allowlist enforcement, command update idempotency, durable reply retry, rate limiting, transient delivery retry, recipient removal, message-body scrubbing, and UTC daily-summary fanout.
- No real Telegram credential is configured and no Bot API request has been made. The external delivery path remains unverified and is not an alerting SLA.

## Revisit when

The owner explicitly authorizes the external connection and configures a dedicated bot token and exact allowlists locally. Before enabling it, review data-retention requirements, operator access, Telegram account security, and the privacy implications of sending position/statistics content to the selected chats.
