import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendAudit, readState, writeState } from '../database.mjs';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4000;
const RETRY_MS = 5000;
const MAX_DELIVERY_ATTEMPTS = 12;

function storedJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? {}; } catch { return {}; }
}

function safeReasonCodes(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)).slice(0, 4);
}

function notificationsForAudit(event, db) {
  const metadata = storedJson(event.metadata_json);
  const positionEvents = Array.isArray(metadata.events) ? metadata.events.map((item) => item?.type).filter((item) => typeof item === 'string') : [];
  switch (event.event_type) {
    case 'TELEGRAM_BOT_STARTED':
      return [{ type: 'BOT_ON', text: 'NEXORA Telegram bridge is online. Controls are paper-only.' }];
    case 'TELEGRAM_BOT_STOPPED':
      return [{ type: 'BOT_OFF', text: 'NEXORA Telegram bridge is stopping. No live trading capability exists.' }];
    case 'PAPER_SCAN_REJECTED': {
      const reasons = safeReasonCodes(metadata.reasons);
      return [{ type: 'SCAN', text: 'Paper scan held; no order was created.' + (reasons.length ? ' Gates: ' + reasons.join(', ') : '') }];
    }
    case 'PAPER_ORDER_INTENT_AUDITED':
      return [{ type: 'SCAN', text: 'Paper scan passed configured gates and staged a paper-only order intent. Live order: none.' }];
    case 'PAPER_ORDER_STAGED':
      return [{ type: 'ORDER_PENDING', text: 'A paper XAUUSD order is pending. Live order: none.' }];
    case 'PAPER_ORDER_PARTIALLY_FILLED':
      return [{ type: 'ORDER_PARTIAL', text: 'A paper XAUUSD order received a partial fill.' }];
    case 'PAPER_ORDER_FILLED':
      return [{ type: 'ORDER_FILLED', text: 'A paper XAUUSD order was filled against the configured simulation.' }];
    case 'PAPER_ORDER_EXPIRED':
      return [{ type: 'ORDER_EXPIRED', text: 'A pending paper XAUUSD order expired.' }];
    case 'PAPER_ORDER_REJECTED':
    case 'PAPER_ORDER_CANCELLED':
    case 'PAPER_ORDER_REMAINDER_CANCELLED':
      return [{ type: 'ORDER_REJECTED', text: 'A paper XAUUSD order was rejected or cancelled. Review the local audit for its reason.' }];
    case 'PAPER_ORDER_RISK_REJECTED':
    case 'ENTRY_RESUME_REJECTED': {
      const reasons = safeReasonCodes(metadata.readinessReasons ?? metadata.reasons);
      return [{ type: 'RISK_GUARD', text: 'A risk/readiness guard blocked an action.' + (reasons.length ? ' Gates: ' + reasons.join(', ') : '') }];
    }
    case 'PAPER_POSITION_UPDATED':
    case 'PAPER_POSITION_CLOSED': {
      const types = new Set(positionEvents);
      const isClosed = event.event_type === 'PAPER_POSITION_CLOSED';
      if (types.has('HIT_TP1')) return [{ type: 'POSITION_TP1', text: 'A paper XAUUSD position reached TP1; the remaining position is protected according to paper rules.' }];
      if (types.has('HIT_TP2')) return [{ type: 'POSITION_TP2', text: 'A paper XAUUSD position closed at TP2.' }];
      if (types.has('SL_DIRECT') || types.has('SL_AFTER_TP1')) {
        return [{ type: 'POSITION_STOP', text: 'A paper XAUUSD position closed at a stop (' + (types.has('SL_AFTER_TP1') ? 'SL_AFTER_TP1' : 'SL_DIRECT') + ').' }];
      }
      return isClosed ? [{ type: 'POSITION_CLOSED', text: 'A paper XAUUSD position closed. Review the local journal for the exit details.' }] : [];
    }
    case 'BROKER_HEALTH_CHANGED': {
      const status = metadata.status;
      const label = ['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE'].includes(status) ? status : 'UNKNOWN';
      return [{ type: 'BROKER_HEALTH', text: 'Broker/feed status changed: ' + label + '. New entries remain gated by freshness and risk checks.' }];
    }
    case 'NEWS_PROVIDER_STATE_CHANGED': {
      const state = readState(db, 'newsProvider', {});
      const eventStatus = metadata.to;
      const currentStatus = ['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE'].includes(state.status) ? state.status : 'UNKNOWN';
      const status = ['HEALTHY', 'STALE', 'OFFLINE', 'UNAVAILABLE'].includes(eventStatus) ? eventStatus : currentStatus;
      return [{ type: 'NEWS_STATE', text: 'News calendar status changed: ' + status + '. Missing or stale news blocks new entries.' }];
    }
    case 'PAPER_MODE_DISABLED':
      return [{ type: 'PAPER_MODE', text: 'Paper mode is OFF and new entries are paused. Live trading is unavailable.' }];
    case 'PAPER_MODE_ENABLED_PAUSED':
      return [{ type: 'PAPER_MODE', text: 'Paper mode is ON; entries remain paused until a separate readiness-approved resume.' }];
    case 'ENTRY_PAUSED':
      return [{ type: 'ENTRY_STATE', text: 'New paper entries were paused.' }];
    case 'ENTRY_RESUMED':
      return [{ type: 'ENTRY_STATE', text: 'Paper entry evaluation was resumed after readiness checks.' }];
    case 'WORKER_TICK_FAILED':
      return [{ type: 'RISK_GUARD', text: 'The local worker failed safely; inspect dashboard health. New entries are held.' }];
    default:
      return [];
  }
}

function deliveryFingerprint(salt, chatId) {
  return createHash('sha256').update(salt).update('\0').update(chatId).digest('hex');
}

export function parseTelegramCommand(text) {
  if (typeof text !== 'string' || text.length > 1000) return null;
  const [head, ...args] = text.trim().split(/\s+/);
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?$/i.exec(head ?? '');
  if (!match) return null;
  return { name: match[1].toLowerCase(), args };
}

function stateFor(db, settings) {
  return readState(db, 'telegram', {
    enabled: settings.enabled,
    configured: Boolean(settings.token && settings.allowedUserIds?.length && settings.allowedChatIds?.length),
    notificationsEnabled: Boolean(settings.notificationsEnabled),
    status: settings.enabled ? 'STARTING' : 'DISABLED',
    updatedAt: null,
    lastUpdateAt: null,
    lastErrorCode: null,
  });
}

export class TelegramService {
  constructor({
    db, settings, commandHandler, fetchImpl = fetch, clock = () => new Date(),
    dailySummaryProvider = null, sleepImpl = sleep, minimumSendIntervalMs = 1000, commandCooldownMs = 1000,
  }) {
    if (!db || !settings || typeof commandHandler !== 'function' || typeof fetchImpl !== 'function') {
      throw new TypeError('Telegram service dependencies are required.');
    }
    if (dailySummaryProvider !== null && typeof dailySummaryProvider !== 'function') {
      throw new TypeError('Daily summary provider must be a function.');
    }
    this.db = db;
    this.settings = settings;
    this.commandHandler = commandHandler;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.dailySummaryProvider = dailySummaryProvider;
    this.sleepImpl = sleepImpl;
    this.minimumSendIntervalMs = Math.max(0, Number(minimumSendIntervalMs) || 0);
    this.commandCooldownMs = Math.max(0, Number(commandCooldownMs) || 0);
    this.controller = null;
    this.loopPromise = null;
    this.stopping = false;
    this.commandLastAt = new Map();
    this.nextSendAt = 0;
    this.stopPromise = null;
  }

  getStatus() {
    const state = stateFor(this.db, this.settings);
    return {
      enabled: Boolean(this.settings.enabled),
      configured: Boolean(this.settings.token && this.settings.allowedUserIds?.length && this.settings.allowedChatIds?.length),
      notificationsEnabled: Boolean(this.settings.notificationsEnabled),
      status: state.status,
      updatedAt: state.updatedAt,
      lastUpdateAt: state.lastUpdateAt,
      lastErrorCode: state.lastErrorCode,
    };
  }

  setStatus(status, lastErrorCode = null, lastUpdateAt = undefined) {
    const previous = stateFor(this.db, this.settings);
    const next = {
      enabled: Boolean(this.settings.enabled),
      configured: Boolean(this.settings.token && this.settings.allowedUserIds?.length && this.settings.allowedChatIds?.length),
      notificationsEnabled: Boolean(this.settings.notificationsEnabled),
      status,
      updatedAt: this.clock().toISOString(),
      lastUpdateAt: lastUpdateAt === undefined ? previous.lastUpdateAt : lastUpdateAt,
      lastErrorCode,
    };
    writeState(this.db, 'telegram', next, next.updatedAt);
    return next;
  }

  async apiCall(method, payload, signal) {
    const endpoint = TELEGRAM_API + '/bot' + this.settings.token + '/' + method;
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 25_000 : 10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.ok !== true) {
      const description = typeof body?.description === 'string' ? body.description : '';
      const apiStatus = Number(body?.error_code ?? response.status);
      const code = /webhook.+active|can't use getUpdates.+webhook/i.test(description)
        ? 'WEBHOOK_CONFIGURED'
        : apiStatus === 429 ? 'TELEGRAM_RATE_LIMITED'
          : method === 'sendMessage' && [400, 403].includes(apiStatus) ? 'RECIPIENT_UNAVAILABLE'
            : method === 'sendMessage' ? 'TELEGRAM_REPLY_FAILED' : 'TELEGRAM_POLL_FAILED';
      const error = new Error(code);
      error.code = code;
      const retryAfter = Number(body?.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = Math.min(300_000, retryAfter * 1000);
      throw error;
    }
    return body.result;
  }

  async sendMessage(chatId, text, signal) {
    const waitMs = Math.max(0, this.nextSendAt - Date.now());
    if (waitMs > 0) await this.sleepImpl(waitMs, undefined, signal ? { signal } : undefined);
    this.nextSendAt = Date.now() + this.minimumSendIntervalMs;
    return this.apiCall('sendMessage', {
      chat_id: chatId,
      text: Array.from(text).slice(0, MAX_MESSAGE_LENGTH).join(''),
      disable_web_page_preview: true,
    }, signal);
  }

  async processUpdate(update, signal) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return;
    const previousOffset = readState(this.db, 'telegramUpdateOffset', null);
    if (Number.isSafeInteger(previousOffset) && update.update_id <= previousOffset) return;
    const message = update.message;
    const hasNumericIdentity = Number.isSafeInteger(message?.from?.id)
      && Number.isSafeInteger(message?.chat?.id);
    const userId = hasNumericIdentity ? String(message.from.id) : null;
    const chatId = hasNumericIdentity ? String(message.chat.id) : null;
    const allowed = Boolean(userId && chatId)
      && this.settings.allowedUserIds?.includes(userId)
      && this.settings.allowedChatIds?.includes(chatId);
    let reply = null;
    if (allowed && typeof message.text === 'string') {
      const command = parseTelegramCommand(message.text);
      if (command) {
        const nowMs = this.clock().getTime();
        const rateKey = userId + ':' + chatId;
        const previousCommand = this.commandLastAt.get(rateKey);
        if (previousCommand && previousCommand.updateId !== update.update_id
          && nowMs - previousCommand.at < this.commandCooldownMs) {
          reply = 'Rate limit: tunggu sebentar sebelum mengirim command lagi.';
        } else {
          reply = await this.commandHandler({
            command,
            updateId: update.update_id,
            userId,
            chatId,
          });
          this.commandLastAt.set(rateKey, { at: this.clock().getTime(), updateId: update.update_id });
        }
      }
    }
    const at = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof reply === 'string' && reply.trim()) {
        let salt = readState(this.db, 'telegramDeliverySalt', null);
        if (typeof salt !== 'string' || salt.length < 32) {
          salt = randomBytes(32).toString('hex');
          writeState(this.db, 'telegramDeliverySalt', salt, at);
        }
        const storedReply = Array.from(reply).slice(0, MAX_MESSAGE_LENGTH).join('');
        this.db.prepare('INSERT OR IGNORE INTO telegram_notification_outbox (event_key, recipient_fingerprint, event_type, message_text, created_at) VALUES (?, ?, ?, ?, ?)')
          .run('command-reply:' + update.update_id, deliveryFingerprint(salt, chatId), 'COMMAND_REPLY', storedReply, at);
      }
      writeState(this.db, 'telegramUpdateOffset', update.update_id, at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const status = this.getStatus();
    this.setStatus(status.status, status.lastErrorCode, at);
  }

  async pollOnce(signal) {
    if (!this.settings.enabled) return [];
    const lastUpdateId = readState(this.db, 'telegramUpdateOffset', null);
    const payload = { timeout: 20, limit: 100, allowed_updates: ['message'] };
    if (Number.isSafeInteger(lastUpdateId) && lastUpdateId >= 0) payload.offset = lastUpdateId + 1;
    const updates = await this.apiCall('getUpdates', payload, signal);
    if (!Array.isArray(updates)) throw Object.assign(new Error('TELEGRAM_POLL_FAILED'), { code: 'TELEGRAM_POLL_FAILED' });
    for (const update of updates.sort((left, right) => (left?.update_id ?? 0) - (right?.update_id ?? 0))) {
      await this.processUpdate(update, signal);
    }
    await this.drainNotificationOutbox(signal);
    const deliveryFailure = this.db.prepare("SELECT last_error_code FROM telegram_notification_outbox WHERE sent_at IS NULL AND last_error_code IN ('TELEGRAM_REPLY_FAILED', 'TELEGRAM_RATE_LIMITED') ORDER BY id LIMIT 1").get();
    this.setStatus(deliveryFailure ? 'DEGRADED' : 'CONNECTED', deliveryFailure?.last_error_code ?? null);
    return updates;
  }

  primeNotificationCursor() {
    if (!this.settings.notificationsEnabled) return;
    const current = readState(this.db, 'telegramNotificationCursor', null);
    if (Number.isSafeInteger(current)) return;
    const latest = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS latest FROM audit_events').get().latest;
    writeState(this.db, 'telegramNotificationCursor', Number(latest), this.clock().toISOString());
  }

  queueAuditNotifications() {
    if (!this.settings.notificationsEnabled) return 0;
    this.primeNotificationCursor();
    const cursor = readState(this.db, 'telegramNotificationCursor', 0);
    const events = this.db.prepare('SELECT rowid AS sequence, id, event_type, metadata_json FROM audit_events WHERE rowid > ? ORDER BY rowid LIMIT 250')
      .all(cursor);
    if (!events.length) return 0;
    const at = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let salt = readState(this.db, 'telegramDeliverySalt', null);
      if (typeof salt !== 'string' || salt.length < 32) {
        salt = randomBytes(32).toString('hex');
        writeState(this.db, 'telegramDeliverySalt', salt, at);
      }
      const insert = this.db.prepare('INSERT OR IGNORE INTO telegram_notification_outbox (event_key, recipient_fingerprint, event_type, message_text, created_at) VALUES (?, ?, ?, ?, ?)');
      let enqueued = 0;
      for (const event of events) {
        const messages = notificationsForAudit(event, this.db);
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          for (const chatId of this.settings.allowedChatIds ?? []) {
            const result = insert.run('audit:' + event.id + ':' + index,
              deliveryFingerprint(salt, chatId), message.type, message.text, at);
            enqueued += Number(result.changes ?? 0);
          }
        }
      }
      writeState(this.db, 'telegramNotificationCursor', events.at(-1).sequence, at);
      this.db.exec('COMMIT');
      return enqueued;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async queueDailySummaries() {
    if (!this.settings.notificationsEnabled || typeof this.dailySummaryProvider !== 'function') return 0;
    const now = this.clock();
    if (now.getUTCHours() < Number(this.settings.dailySummaryHourUtc ?? 0)) return 0;
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
    const previous = readState(this.db, 'telegramDailySummaryDate', null);
    const dates = [];
    if (typeof previous !== 'string') dates.push(yesterday);
    else {
      let candidate = new Date(Date.parse(previous + 'T00:00:00.000Z') + 86_400_000);
      for (let count = 0; count < 7 && candidate.toISOString().slice(0, 10) <= yesterday; count += 1) {
        dates.push(candidate.toISOString().slice(0, 10));
        candidate = new Date(candidate.getTime() + 86_400_000);
      }
    }
    if (!dates.length) return 0;
    const summaries = [];
    for (const date of dates) {
      const rawMessage = await this.dailySummaryProvider(date);
      const message = typeof rawMessage === 'string' ? Array.from(rawMessage).slice(0, MAX_MESSAGE_LENGTH).join('') : '';
      if (!message.trim()) throw new TypeError('Daily summary provider returned no message.');
      summaries.push({ date, message });
    }
    this.primeNotificationCursor();
    const at = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let salt = readState(this.db, 'telegramDeliverySalt', null);
      if (typeof salt !== 'string' || salt.length < 32) {
        salt = randomBytes(32).toString('hex');
        writeState(this.db, 'telegramDeliverySalt', salt, at);
      }
      const insert = this.db.prepare('INSERT OR IGNORE INTO telegram_notification_outbox (event_key, recipient_fingerprint, event_type, message_text, created_at) VALUES (?, ?, ?, ?, ?)');
      let enqueued = 0;
      for (const { date, message } of summaries) {
        for (const chatId of this.settings.allowedChatIds ?? []) {
          const result = insert.run('daily-summary:' + date,
            deliveryFingerprint(salt, chatId), 'DAILY_SUMMARY', message, at);
          enqueued += Number(result.changes ?? 0);
        }
        writeState(this.db, 'telegramDailySummaryDate', date, at);
      }
      this.db.exec('COMMIT');
      return enqueued;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async drainNotificationOutbox(signal) {
    const salt = readState(this.db, 'telegramDeliverySalt', null);
    if (typeof salt !== 'string') return 0;
    const targets = new Map((this.settings.allowedChatIds ?? [])
      .map((chatId) => [deliveryFingerprint(salt, chatId), chatId]));
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE telegram_notification_outbox SET last_error_code = 'DELIVERY_RETRY_LIMIT', retry_after_at = NULL WHERE sent_at IS NULL AND attempts >= ? AND last_error_code IS NULL")
      .run(MAX_DELIVERY_ATTEMPTS);
    const deliveryFilter = this.settings.notificationsEnabled ? '' : " AND event_type = 'COMMAND_REPLY'";
    const pending = this.db.prepare("SELECT id, recipient_fingerprint, message_text, attempts FROM telegram_notification_outbox WHERE sent_at IS NULL AND attempts < ? AND (retry_after_at IS NULL OR retry_after_at <= ?) AND (last_error_code IS NULL OR last_error_code IN ('TELEGRAM_REPLY_FAILED', 'TELEGRAM_RATE_LIMITED'))" + deliveryFilter + ' ORDER BY id LIMIT 20')
      .all(MAX_DELIVERY_ATTEMPTS, now);
    let delivered = 0;
    for (const item of pending) {
      const chatId = targets.get(item.recipient_fingerprint);
      if (chatId === undefined) {
        this.db.prepare("UPDATE telegram_notification_outbox SET last_error_code = 'RECIPIENT_NOT_ALLOWLISTED', message_text = '[DISCARDED]' WHERE id = ?").run(item.id);
        continue;
      }
      const attempts = Number(item.attempts) + 1;
      this.db.prepare('UPDATE telegram_notification_outbox SET attempts = ?, last_error_code = NULL WHERE id = ?')
        .run(attempts, item.id);
      try {
        await this.sendMessage(Number(chatId), item.message_text, signal);
        this.db.prepare("UPDATE telegram_notification_outbox SET sent_at = ?, retry_after_at = NULL, last_error_code = NULL, message_text = '[DELIVERED]' WHERE id = ?")
          .run(this.clock().toISOString(), item.id);
        delivered += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.code === 'RECIPIENT_UNAVAILABLE') {
          this.db.prepare("UPDATE telegram_notification_outbox SET last_error_code = 'RECIPIENT_UNAVAILABLE', retry_after_at = NULL, message_text = '[DISCARDED]' WHERE id = ?")
            .run(item.id);
          continue;
        }
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          this.db.prepare("UPDATE telegram_notification_outbox SET last_error_code = 'DELIVERY_RETRY_LIMIT', retry_after_at = NULL, message_text = '[DISCARDED]' WHERE id = ?")
            .run(item.id);
          continue;
        }
        const delayMs = Math.max(RETRY_MS, Number(error?.retryAfterMs) || 0);
        const retryAt = new Date(this.clock().getTime() + delayMs).toISOString();
        const code = error?.code === 'TELEGRAM_RATE_LIMITED' ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_REPLY_FAILED';
        this.db.prepare('UPDATE telegram_notification_outbox SET last_error_code = ?, retry_after_at = ? WHERE id = ?')
          .run(code, retryAt, item.id);
        this.setStatus('DEGRADED', code);
        break;
      }
    }
    return delivered;
  }

  async flushNotifications(signal) {
    if (!this.settings.enabled) return 0;
    const queued = this.settings.notificationsEnabled ? this.queueAuditNotifications() : 0;
    const daily = this.settings.notificationsEnabled ? await this.queueDailySummaries() : 0;
    const delivered = await this.drainNotificationOutbox(signal);
    return { queued, daily, delivered };
  }

  start() {
    if (!this.settings.enabled) {
      this.setStatus('DISABLED');
      return;
    }
    if (this.loopPromise) return;
    this.stopping = false;
    this.controller = new AbortController();
    const previousStatus = readState(this.db, 'telegram', {}).status;
    if (this.settings.notificationsEnabled) {
      this.primeNotificationCursor();
      if (previousStatus === 'CONNECTED') {
        appendAudit(this.db, {
          actor: 'telegram-service', eventType: 'TELEGRAM_BOT_STOPPED',
          reason: 'Telegram process restarted without a recorded clean shutdown.',
          metadata: { recovery: true },
        }, this.clock().toISOString());
      }
      appendAudit(this.db, {
        actor: 'telegram-service', eventType: 'TELEGRAM_BOT_STARTED',
        reason: 'Telegram long-poll bridge started with locally configured allowlists.',
        metadata: { notificationsEnabled: true },
      }, this.clock().toISOString());
    }
    this.setStatus('STARTING');
    this.loopPromise = this.run(this.controller.signal);
  }

  async run(signal) {
    while (!this.stopping) {
      try {
        await this.pollOnce(signal);
        await this.flushNotifications(signal);
      } catch (error) {
        if (signal.aborted) break;
        const code = error?.code === 'WEBHOOK_CONFIGURED' ? 'WEBHOOK_CONFIGURED'
          : error?.code === 'TELEGRAM_RATE_LIMITED' ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_POLL_FAILED';
        this.setStatus('DEGRADED', code);
        const delayMs = Math.max(RETRY_MS, Number(error?.retryAfterMs) || 0);
        try { await this.sleepImpl(delayMs, undefined, { signal }); } catch { break; }
      }
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.settings.enabled && this.settings.notificationsEnabled) {
        appendAudit(this.db, {
          actor: 'telegram-service', eventType: 'TELEGRAM_BOT_STOPPED',
          reason: 'Telegram service is stopping cleanly.',
          metadata: {},
        }, this.clock().toISOString());
      }
      this.stopping = true;
      this.controller?.abort();
      await this.loopPromise;
      if (this.settings.enabled) {
        try { await this.flushNotifications(); } catch { this.setStatus('DEGRADED', 'TELEGRAM_REPLY_FAILED'); }
      }
      this.loopPromise = null;
      this.controller = null;
      if (this.settings.enabled) this.setStatus('STOPPED');
    })();
    return this.stopPromise;
  }
}
