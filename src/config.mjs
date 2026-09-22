import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveStrategyParameters, STRATEGY_PARAMETER_RATIONALE } from './domain/strategy.mjs';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function runtimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(path) : entry.isFile() ? [path] : [];
  });
}

function localBuildId() {
  const files = [
    resolve(PROJECT_ROOT, 'package.json'),
    ...runtimeFiles(resolve(PROJECT_ROOT, 'src')),
    ...runtimeFiles(resolve(PROJECT_ROOT, 'dist')),
  ].sort((left, right) => {
    const leftName = relative(PROJECT_ROOT, left).split(sep).join('/');
    const rightName = relative(PROJECT_ROOT, right).split(sep).join('/');
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(PROJECT_ROOT, path).split(sep).join('/')).update(String.fromCharCode(0)).update(readFileSync(path)).update(String.fromCharCode(0));
  }
  return 'LOCAL-' + hash.digest('hex').slice(0, 12);
}

const liveFlag = (process.env.LIVE_TRADING_ENABLED ?? 'false').trim().toLowerCase();
if (liveFlag !== 'false') {
  throw new Error('Live trading is not implemented. LIVE_TRADING_ENABLED must remain false.');
}

const host = process.env.NEXORA_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(host)) {
  throw new Error('NEXORA_HOST must be loopback-only; public/network binding is disabled.');
}

const port = Number(process.env.NEXORA_PORT ?? 18765);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('NEXORA_PORT must be an integer from 0 to 65535.');
}

const operatorToken = (process.env.NEXORA_CONTROL_TOKEN ?? '').trim();
if (operatorToken && operatorToken.length < 32) {
  throw new Error('NEXORA_CONTROL_TOKEN must be at least 32 characters; no token value is logged.');
}

const telegramEnabledFlag = (process.env.NEXORA_TELEGRAM_ENABLED ?? 'false').trim().toLowerCase();
if (!['true', 'false'].includes(telegramEnabledFlag)) {
  throw new Error('NEXORA_TELEGRAM_ENABLED must be true or false.');
}
const telegramEnabled = telegramEnabledFlag === 'true';
const telegramNotificationsFlag = (process.env.NEXORA_TELEGRAM_NOTIFICATIONS_ENABLED ?? 'false').trim().toLowerCase();
if (!['true', 'false'].includes(telegramNotificationsFlag)) {
  throw new Error('NEXORA_TELEGRAM_NOTIFICATIONS_ENABLED must be true or false.');
}
const telegramNotificationsEnabled = telegramNotificationsFlag === 'true';
const telegramDailySummaryHourUtc = Number(process.env.NEXORA_TELEGRAM_DAILY_SUMMARY_UTC_HOUR ?? '0');
if (!Number.isInteger(telegramDailySummaryHourUtc) || telegramDailySummaryHourUtc < 0 || telegramDailySummaryHourUtc > 23) {
  throw new Error('NEXORA_TELEGRAM_DAILY_SUMMARY_UTC_HOUR must be an integer from 0 to 23.');
}
function telegramAllowlist(name, pattern) {
  const values = (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !pattern.test(value) || !Number.isSafeInteger(Number(value)))
    || new Set(values).size !== values.length) {
    throw new Error(name + ' must contain unique numeric IDs separated by commas; no values are logged.');
  }
  return Object.freeze(values);
}
const telegramToken = (process.env.NEXORA_TELEGRAM_BOT_TOKEN ?? '').trim();
const telegramAllowedUserIds = telegramAllowlist('NEXORA_TELEGRAM_ALLOWED_USER_IDS', /^[1-9][0-9]{0,19}$/);
const telegramAllowedChatIds = telegramAllowlist('NEXORA_TELEGRAM_ALLOWED_CHAT_IDS', /^-?[1-9][0-9]{0,19}$/);
if (telegramEnabled) {
  if (!/^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) {
    throw new Error('Telegram is enabled but NEXORA_TELEGRAM_BOT_TOKEN is missing or invalid; no token value is logged.');
  }
  if (!telegramAllowedUserIds.length || !telegramAllowedChatIds.length) {
    throw new Error('Telegram requires both user-ID and chat-ID allowlists; no ID values are logged.');
  }
  if (!operatorToken) {
    throw new Error('Telegram controls require NEXORA_CONTROL_TOKEN to be configured.');
  }
}
if (telegramNotificationsEnabled && !telegramEnabled) {
  throw new Error('Telegram notifications require NEXORA_TELEGRAM_ENABLED=true.');
}

const paperFlag = (process.env.PAPER_MODE ?? 'true').trim().toLowerCase();
if (!['true', 'false'].includes(paperFlag)) throw new Error('PAPER_MODE must be true or false.');

function configuredSymbols(value) {
  const symbols = String(value ?? 'XAUUSD,EURUSD,GBPUSD,USDJPY')
    .split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.length > 16 || symbols.some((symbol) => !/^[A-Z0-9]{6,12}$/.test(symbol))) {
    throw new Error('NEXORA_SYMBOLS must contain 1-16 uppercase market symbols separated by commas.');
  }
  if (!symbols.includes('XAUUSD')) symbols.unshift('XAUUSD');
  return Object.freeze([...new Set(symbols)]);
}

const symbols = configuredSymbols(process.env.NEXORA_SYMBOLS);

const paperStartingEquityRaw = String(process.env.NEXORA_PAPER_STARTING_EQUITY ?? '').trim();
const paperStartingEquity = paperStartingEquityRaw === '' ? null : Number(paperStartingEquityRaw);
if (paperStartingEquity != null && (!Number.isFinite(paperStartingEquity) || paperStartingEquity <= 0)) {
  throw new Error('NEXORA_PAPER_STARTING_EQUITY must be a positive number when configured.');
}
const paperCurrency = String(process.env.NEXORA_PAPER_CURRENCY ?? 'USD').trim().toUpperCase();
if (!/^[A-Z]{3,8}$/.test(paperCurrency)) throw new Error('NEXORA_PAPER_CURRENCY must be an uppercase currency code.');
const paperMaxSpreadRaw = String(process.env.NEXORA_PAPER_MAX_SPREAD_PRICE ?? '').trim();
const paperMaxSpreadPrice = paperMaxSpreadRaw === '' ? null : Number(paperMaxSpreadRaw);
if (paperMaxSpreadPrice != null && (!Number.isFinite(paperMaxSpreadPrice) || paperMaxSpreadPrice <= 0)) {
  throw new Error('NEXORA_PAPER_MAX_SPREAD_PRICE must be a positive number when configured.');
}

function safeProviderLabel(value) {
  const label = String(value ?? '').trim();
  const looksSensitive = /(?:token|secret|api[-_.]?key|auth|password|credential|bearer)/i.test(label);
  return label.length <= 24 && !looksSensitive && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) ? label : 'unknown';
}

export function fingerprintConfiguration(configuration, prefix = 'nexora-paper') {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError('A configuration manifest is required to calculate its version.');
  }
  const digest = createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 12);
  return prefix + '-' + digest;
}

const strategyProfileId = 'mtf-paper-v1';
const strategyParameters = resolveStrategyParameters();
const parameterRationale = Object.freeze({
  strategy: STRATEGY_PARAMETER_RATIONALE,
  risk: Object.freeze({
    riskPerTradePct: 'The product brief sets a conservative 0.25% paper default; it is not a live-risk recommendation.',
    maxTotalOpenRiskPct: 'The product brief caps combined open paper risk at 5%.',
    dailyLossLimitR: 'The product brief pauses new entries at 3R daily loss.',
    drawdownWarningPct: 'The product brief requests a 5% drawdown warning.',
    drawdownPausePct: 'The product brief pauses entries at 10% drawdown.',
    emergencyStopPct: 'The product brief requests an emergency stop at 20%; an account/provider may require a tighter limit.',
    minRiskReward: 'The product brief requires at least 2R to TP1 before an entry is eligible.',
    minSignalScore: 'The product brief requires score 70/100; the score is an unvalidated heuristic, not expected-return evidence.',
    minConfluencePct: 'The product brief requires at least 60% timeframe confluence; MTF hard gates still apply.',
    maxSpreadPrice: 'No default is fabricated; this must be supplied from verified instrument/provider configuration or entries remain blocked.',
    newsBlackoutBeforeMinutes: 'The product brief sets a 30-minute pre-event blackout for high-impact USD events.',
    newsBlackoutAfterMinutes: 'The product brief sets a 30-minute post-event blackout for high-impact USD events.',
  }),
});

const risk = Object.freeze({
  riskPerTradePct: 0.25,
  maxTotalOpenRiskPct: 5,
  dailyLossLimitR: 3,
  drawdownWarningPct: 5,
  drawdownPausePct: 10,
  emergencyStopPct: 20,
  minRiskReward: 2,
  minSignalScore: 70,
  minConfluencePct: 60,
  maxSpreadPrice: paperMaxSpreadPrice,
  newsBlackoutBeforeMinutes: 30,
  newsBlackoutAfterMinutes: 30,
});
const strategyVersion = fingerprintConfiguration({ risk, strategyParameters, parameterRationale }, strategyProfileId);

export const config = Object.freeze({
  host,
  port,
  dbPath: resolve(process.cwd(), process.env.NEXORA_DB_PATH ?? './data/nexora.sqlite'),
  paperMode: paperFlag === 'true',
  liveTradingEnabled: false,
  symbols,
  paperStartingEquity,
  paperCurrency,
  brokerName: safeProviderLabel(process.env.NEXORA_BROKER ?? 'none'),
  marketSource: safeProviderLabel(process.env.NEXORA_MARKET_SOURCE ?? 'none'),
  marketProvider: safeProviderLabel(process.env.NEXORA_MARKET_SOURCE ?? 'none').toLowerCase(),
  newsSource: safeProviderLabel(process.env.NEXORA_NEWS_SOURCE ?? 'none').toLowerCase(),
  operatorToken: operatorToken || null,
  telegram: Object.freeze({
    enabled: telegramEnabled,
    notificationsEnabled: telegramNotificationsEnabled,
    dailySummaryHourUtc: telegramDailySummaryHourUtc,
    token: telegramToken || null,
    allowedUserIds: telegramAllowedUserIds,
    allowedChatIds: telegramAllowedChatIds,
  }),
  buildId: localBuildId(),
  schemaVersion: 9,
  strategyProfileId,
  strategyVersion,
  strategyParameters,
  parameterRationale,
  risk,
});
