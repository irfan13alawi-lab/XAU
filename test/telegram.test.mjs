import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendAudit, openDatabase, readState } from '../src/database.mjs';
import { initializeDatabase, telegramDailySummary } from '../src/server.mjs';
import { parseTelegramCommand, TelegramService } from '../src/services/telegram-service.mjs';

const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
const token = 'fake-telegram-token-for-mocked-tests-only';

function response(result, status = 200) {
  return new Response(JSON.stringify({ ok: status >= 200 && status < 300, result }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function fixtureDatabase() {
  const db = openDatabase(':memory:', migrations);
  initializeDatabase(db, new Date('2026-09-21T00:00:00.000Z'));
  return db;
}

test('daily summary includes every close from the completed UTC date', () => {
  const db = fixtureDatabase();
  try {
    db.prepare(`INSERT INTO orders (
      id, idempotency_key, symbol, side, order_type, status, quantity_lots, entry_price,
      stop_price, take_profit_1, take_profit_2, expires_at, created_at, updated_at, snapshot_json
    ) VALUES (?, ?, 'XAUUSD', 'BUY', 'LIMIT', 'FILLED', '0.1', '2500', '2490', '2520', '2530', ?, ?, ?, '{}')`)
      .run('order-daily-summary', 'daily-summary-test', '2026-09-20T19:00:00.000Z', '2026-09-20T18:00:00.000Z', '2026-09-20T19:00:00.000Z');
    db.prepare(`INSERT INTO positions (
      id, order_id, symbol, side, status, quantity_open_lots, quantity_initial_lots,
      entry_price, stop_price, take_profit_1, take_profit_2, tp1_hit, realized_pnl,
      mfe, mae, opened_at, closed_at, close_reason, snapshot_json
    ) VALUES (?, ?, 'XAUUSD', 'LONG', 'CLOSED', '0', '0.1', '2500', '2490', '2520', '2530', 0, '12.34', '20', '3', ?, ?, 'HIT_TP2', '{}')`)
      .run('position-daily-summary', 'order-daily-summary', '2026-09-20T18:00:00.000Z', '2026-09-20T20:30:00.000Z');
    db.prepare(`INSERT INTO trades (
      id, position_id, symbol, side, gross_pnl, net_pnl, pnl_r, commission, swap,
      close_reason, setup_quality, market_condition, opened_at, closed_at, duration_seconds,
      entry_delay_seconds, mfe, mae, snapshot_json
    ) VALUES (?, ?, 'XAUUSD', 'BUY', '12.34', '12.34', 1.2, '0', '0', 'HIT_TP2', '', '', ?, ?, 9000, 0, '20', '3', ?)`)
      .run('trade-daily-summary', 'position-daily-summary', '2026-09-20T18:00:00.000Z', '2026-09-20T20:30:00.000Z', JSON.stringify({ executionCosts: { accountCurrency: 'USD' } }));

    const summary = telegramDailySummary(db, '2026-09-20');
    assert.match(summary, /Closed trades: 1/);
    assert.match(summary, /Realized net PnL: USD 12\.34/);
  } finally {
    db.close();
  }
});

test('Telegram command parser accepts slash commands and optional bot suffix only', () => {
  assert.deepEqual(parseTelegramCommand('/status'), { name: 'status', args: [] });
  assert.deepEqual(parseTelegramCommand('/paper@NexoraBot off'), { name: 'paper', args: ['off'] });
  assert.equal(parseTelegramCommand('status'), null);
  assert.deepEqual(parseTelegramCommand('/status extra words'), { name: 'status', args: ['extra', 'words'] });
  assert.equal(parseTelegramCommand('x'.repeat(1001)), null);
});

test('Telegram disabled by default means no Bot API request is made', () => {
  const db = fixtureDatabase();
  let requestCount = 0;
  const service = new TelegramService({
    db,
    settings: { enabled: false, token: null, allowedUserIds: [], allowedChatIds: [] },
    fetchImpl: async () => { requestCount += 1; throw new Error('network must not be used'); },
    commandHandler: async () => 'unused',
  });
  try {
    service.start();
    assert.equal(requestCount, 0);
    assert.equal(service.getStatus().status, 'DISABLED');
  } finally {
    db.close();
  }
});

test('long polling requires both allowlists, acknowledges ignored updates, and persists offset without secrets', async () => {
  const db = fixtureDatabase();
  const handled = [];
  const sent = [];
  const polls = [];
  const updates = [
    { update_id: 100, message: { from: { id: 41 }, chat: { id: -1007 }, text: '/pause' } },
    { update_id: 101, channel_post: { chat: { id: -1007 }, text: '/pause' } },
    { update_id: 102, message: { from: { id: 41 }, chat: { id: -1007 }, text: '/pause' } },
    { update_id: 103, message: { from: { id: 42 }, chat: { id: -1008 }, text: '/pause' } },
    { update_id: 104, message: { from: { id: 42 }, chat: { id: -1007 }, text: '/pause' } },
  ];
  const fetchImpl = async (url, options) => {
    const method = new URL(url).pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getUpdates') {
      polls.push(body);
      return response(updates);
    }
    if (method === 'sendMessage') {
      sent.push(body);
      return response({ message_id: sent.length });
    }
    throw new Error('Unexpected fake API method.');
  };
  const service = new TelegramService({
    db,
    settings: { enabled: true, token, allowedUserIds: ['42'], allowedChatIds: ['-1007'] },
    fetchImpl,
    clock: () => new Date('2026-09-21T00:01:00.000Z'),
    commandHandler: async (context) => {
      handled.push(context);
      return 'Entry paper dijeda.';
    },
  });
  try {
    await service.pollOnce();
    assert.deepEqual(handled.map((item) => item.updateId), [104]);
    assert.equal(handled[0].userId, '42');
    assert.equal(handled[0].chatId, '-1007');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Entry paper dijeda.');
    assert.deepEqual(polls[0], { timeout: 20, limit: 100, allowed_updates: ['message'] });
    assert.equal(readState(db, 'telegramUpdateOffset'), 104);
    assert.equal(service.getStatus().status, 'CONNECTED');
    assert.equal(JSON.stringify(service.getStatus()).includes(token), false);
    assert.equal(JSON.stringify(readState(db, 'telegram')).includes(token), false);
  } finally {
    db.close();
  }
});

test('a failed command reply is durably retried without re-executing the command', async () => {
  const db = fixtureDatabase();
  let executions = 0;
  let pollPayload;
  let current = new Date('2026-09-21T10:00:00.000Z');
  const sent = [];
  const service = new TelegramService({
    db,
    settings: { enabled: true, token, allowedUserIds: ['42'], allowedChatIds: ['42'] },
    clock: () => new Date(current),
    minimumSendIntervalMs: 0,
    fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getUpdates') {
        pollPayload = JSON.parse(options.body);
        return response(pollPayload.offset > 77 ? [] : [{ update_id: 77, message: { from: { id: 42 }, chat: { id: 42 }, text: '/pause' } }]);
      }
      sent.push(JSON.parse(options.body));
      if (sent.length === 1) return new Response(JSON.stringify({ ok: false, description: 'internal details must not be stored' }), { status: 500 });
      return response({ message_id: sent.length });
    },
    commandHandler: async () => { executions += 1; return 'completed'; },
  });
  try {
    await service.pollOnce();
    assert.equal(executions, 1);
    assert.equal(readState(db, 'telegramUpdateOffset'), 77);
    assert.equal(service.getStatus().status, 'DEGRADED');
    assert.equal(service.getStatus().lastErrorCode, 'TELEGRAM_REPLY_FAILED');
    assert.equal(db.prepare('SELECT sent_at FROM telegram_notification_outbox').get().sent_at, null);
    await service.pollOnce();
    assert.equal(service.getStatus().status, 'DEGRADED');
    assert.equal(service.getStatus().lastErrorCode, 'TELEGRAM_REPLY_FAILED');
    current = new Date(current.getTime() + 6000);
    await service.pollOnce();
    assert.equal(pollPayload.offset, 78);
    assert.equal(executions, 1);
    assert.equal(sent.length, 2);
    const delivered = db.prepare('SELECT sent_at, message_text FROM telegram_notification_outbox').get();
    assert.ok(delivered.sent_at);
    assert.equal(delivered.message_text, '[DELIVERED]');
    assert.equal(service.getStatus().status, 'CONNECTED');
  } finally {
    db.close();
  }
});

test('a command failure leaves its update unacknowledged for idempotent retry', async () => {
  const db = fixtureDatabase();
  const service = new TelegramService({
    db,
    settings: { enabled: true, token, allowedUserIds: ['42'], allowedChatIds: ['42'] },
    fetchImpl: async () => response([{ update_id: 80, message: { from: { id: 42 }, chat: { id: 42 }, text: '/resume' } }]),
    commandHandler: async () => { throw new Error('local action failed'); },
  });
  try {
    await assert.rejects(service.pollOnce(), /local action failed/);
    assert.equal(readState(db, 'telegramUpdateOffset'), null);
  } finally {
    db.close();
  }
});

test('notification outbox fans out only to allowlisted chats and retries transient delivery once', async () => {
  const db = fixtureDatabase();
  let current = new Date('2026-09-21T10:00:00.000Z');
  const sent = [];
  let failFirstSend = true;
  const service = new TelegramService({
    db,
    settings: {
      enabled: true, notificationsEnabled: true, dailySummaryHourUtc: 0,
      token, allowedUserIds: ['42'], allowedChatIds: ['-1007'],
    },
    clock: () => new Date(current),
    minimumSendIntervalMs: 0,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname.split('/').at(-1), 'sendMessage');
      const body = JSON.parse(options.body);
      sent.push(body);
      if (failFirstSend) {
        failFirstSend = false;
        return new Response(JSON.stringify({ ok: false, description: 'private API details' }), { status: 500 });
      }
      return response({ message_id: sent.length });
    },
    commandHandler: async () => 'unused',
  });
  try {
    service.primeNotificationCursor();
    appendAudit(db, {
      actor: 'paper-worker', eventType: 'PAPER_ORDER_STAGED',
      entityType: 'order', entityId: 'internal-order-id',
      reason: 'Internal fixture reason',
      metadata: { quantityLots: 0.1 },
    }, current.toISOString());

    await service.flushNotifications();
    const first = db.prepare('SELECT * FROM telegram_notification_outbox').get();
    assert.equal(first.event_type, 'ORDER_PENDING');
    assert.equal(first.attempts, 1);
    assert.equal(first.sent_at, null);
    assert.equal(first.last_error_code, 'TELEGRAM_REPLY_FAILED');
    assert.equal(first.message_text.includes('internal-order-id'), false);
    assert.equal(first.message_text.includes(token), false);
    assert.notEqual(first.recipient_fingerprint, '-1007');

    current = new Date(current.getTime() + 6000);
    await service.flushNotifications();
    const delivered = db.prepare('SELECT * FROM telegram_notification_outbox').get();
    assert.equal(delivered.attempts, 2);
    assert.ok(delivered.sent_at);
    assert.equal(delivered.last_error_code, null);
    assert.equal(delivered.message_text, '[DELIVERED]');
    assert.deepEqual(sent.map((item) => item.chat_id), [-1007, -1007]);

    await service.flushNotifications();
    assert.equal(sent.length, 2);
    assert.equal(readState(db, 'telegramNotificationCursor') > 0, true);
  } finally {
    db.close();
  }
});

test('accepted paper scan notification is fixed text and excludes order details', async () => {
  const db = fixtureDatabase();
  const sent = [];
  const service = new TelegramService({
    db,
    settings: {
      enabled: true, notificationsEnabled: true,
      token, allowedUserIds: ['42'], allowedChatIds: ['42'],
    },
    clock: () => new Date('2026-09-21T10:00:00.000Z'),
    minimumSendIntervalMs: 0,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return response({ message_id: sent.length });
    },
    commandHandler: async () => 'unused',
  });
  try {
    service.primeNotificationCursor();
    appendAudit(db, {
      actor: 'paper-worker', eventType: 'PAPER_ORDER_INTENT_AUDITED',
      entityType: 'scan', entityId: 'internal-scan-id',
      reason: 'Accepted intent; private details must not be forwarded.',
      metadata: { score: 91, entry: 2500, reasons: [] },
    }, '2026-09-21T10:00:00.000Z');

    await service.flushNotifications();

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Paper scan passed configured gates/);
    assert.equal(sent[0].text.includes('internal-scan-id'), false);
    assert.equal(sent[0].text.includes('2500'), false);
    assert.equal(db.prepare('SELECT event_type FROM telegram_notification_outbox').get().event_type, 'SCAN');
  } finally {
    db.close();
  }
});

test('outbox scrubs command content when the recipient is removed before delivery', async () => {
  const db = fixtureDatabase();
  const service = new TelegramService({
    db,
    settings: { enabled: true, token, allowedUserIds: ['42'], allowedChatIds: ['42'] },
    fetchImpl: async () => { throw new Error('No network call expected.'); },
    commandHandler: async () => 'Private position details that must not remain queued.',
  });
  try {
    await service.processUpdate({
      update_id: 301,
      message: { from: { id: 42 }, chat: { id: 42 }, text: '/positions' },
    });
    service.settings.allowedChatIds = [];
    await service.drainNotificationOutbox();
    const row = db.prepare('SELECT last_error_code, message_text FROM telegram_notification_outbox').get();
    assert.equal(row.last_error_code, 'RECIPIENT_NOT_ALLOWLISTED');
    assert.equal(row.message_text, '[DISCARDED]');
  } finally {
    db.close();
  }
});

test('daily summary is UTC-dated, paper-only, fanout-idempotent, and currency-safe', async () => {
  const db = fixtureDatabase();
  const sent = [];
  const summaryDates = [];
  const service = new TelegramService({
    db,
    settings: {
      enabled: true, notificationsEnabled: true, dailySummaryHourUtc: 0,
      token, allowedUserIds: ['42'], allowedChatIds: ['-1007', '-1008'],
    },
    clock: () => new Date('2026-09-21T03:00:00.000Z'),
    minimumSendIntervalMs: 0,
    dailySummaryProvider: async (date) => {
      summaryDates.push(date);
      return 'NEXORA daily paper summary · UTC ' + date + ' · realized net PnL unavailable · not a forecast';
    },
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return response({ message_id: sent.length });
    },
    commandHandler: async () => 'unused',
  });
  try {
    service.primeNotificationCursor();
    const first = await service.flushNotifications();
    assert.equal(first.daily, 2);
    assert.deepEqual(summaryDates, ['2026-09-20']);
    assert.deepEqual(sent.map((item) => item.chat_id), [-1007, -1008]);
    assert.ok(sent.every((item) => item.text.includes('paper summary') && item.text.includes('not a forecast')));
    assert.equal(readState(db, 'telegramDailySummaryDate'), '2026-09-20');
    await service.flushNotifications();
    assert.equal(sent.length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM telegram_notification_outbox WHERE event_type = 'DAILY_SUMMARY'").get().count, 2);
  } finally {
    db.close();
  }
});

test('allowlisted command rate limit blocks rapid repeat controls without losing update offset', async () => {
  const db = fixtureDatabase();
  const handled = [];
  const replies = [];
  const service = new TelegramService({
    db,
    settings: { enabled: true, token, allowedUserIds: ['42'], allowedChatIds: ['42'] },
    clock: () => new Date('2026-09-21T10:00:00.000Z'),
    minimumSendIntervalMs: 0,
    fetchImpl: async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      if (method === 'getUpdates') return response([
        { update_id: 200, message: { from: { id: 42 }, chat: { id: 42 }, text: '/pause' } },
        { update_id: 201, message: { from: { id: 42 }, chat: { id: 42 }, text: '/resume' } },
      ]);
      replies.push(JSON.parse(options.body).text);
      return response({ message_id: replies.length });
    },
    commandHandler: async ({ command }) => { handled.push(command.name); return 'ok'; },
  });
  try {
    await service.pollOnce();
    assert.deepEqual(handled, ['pause']);
    assert.equal(replies[0], 'ok');
    assert.match(replies[1], /Rate limit/);
    assert.equal(readState(db, 'telegramUpdateOffset'), 201);
  } finally {
    db.close();
  }
});
