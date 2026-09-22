const SOURCE = 'MARKET_DATA';
const SYMBOL = 'XAU/USD';
const TIMEFRAMES = Object.freeze({ M15: ['15min', 15 * 60_000], M30: ['30min', 30 * 60_000], H1: ['1h', 60 * 60_000], H4: ['4h', 4 * 60 * 60_000] });
const QUOTE_CACHE_MS = 10_000;
const CANDLE_CACHE_MS = 5 * 60_000;
const CANDLE_COUNT = 300;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function apiKey() {
  return String(process.env.NEXORA_TWELVEDATA_API_KEY ?? '').trim();
}

function configuredSpread() {
  const spread = number(process.env.NEXORA_PAPER_SPREAD_PRICE);
  return spread != null && spread > 0 ? spread : null;
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? value.trim() : value.trim() + 'Z';
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function errorWithCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function getJson(url, signal) {
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal });
  } catch {
    throw errorWithCode('MARKET_DATA_NETWORK_ERROR');
  }
  let body;
  try { body = await response.json(); } catch { throw errorWithCode('MARKET_DATA_INVALID_RESPONSE'); }
  if (!response.ok || body?.status === 'error' || body?.code) throw errorWithCode('MARKET_DATA_PROVIDER_ERROR');
  return body;
}

function quoteFromResponse(body, now) {
  const mid = number(body?.rate ?? body?.price ?? body?.close);
  const observedAt = parseTimestamp(body?.timestamp ?? body?.datetime ?? body?.last_quote_at) ?? now;
  const spread = configuredSpread();
  if (mid == null || mid <= 0 || spread == null) return null;
  const half = spread / 2;
  return {
    symbol: 'XAUUSD',
    source: SOURCE,
    bid: Number((mid - half).toFixed(8)),
    ask: Number((mid + half).toFixed(8)),
    last: mid,
    observedAt: observedAt.toISOString(),
  };
}

function candlesFromResponse(body, timeframe, now) {
  const definition = TIMEFRAMES[timeframe];
  const rows = Array.isArray(body?.values) ? body.values : [];
  const intervalMs = definition?.[1];
  if (!intervalMs) return [];
  return rows.map((row) => {
    const startedAt = parseTimestamp(row?.datetime);
    if (!startedAt) return null;
    const closedAt = new Date(startedAt.getTime() + intervalMs);
    const open = number(row?.open);
    const high = number(row?.high);
    const low = number(row?.low);
    const close = number(row?.close);
    const volume = row?.volume == null ? null : number(row.volume);
    if (![open, high, low, close].every((value) => value != null) || closedAt.getTime() > now.getTime()) return null;
    return {
      open, high, low, close,
      tickVolume: volume == null || !Number.isInteger(volume) || volume < 0 ? null : volume,
      closedAt: closedAt.toISOString(),
      source: SOURCE,
    };
  }).filter(Boolean).sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}

export class TwelveDataMarketDataProvider {
  #quote = null;
  #quoteFetchedAt = 0;
  #candles = null;
  #candlesFetchedAt = 0;

  async #readQuote(now, signal) {
    const key = apiKey();
    if (!key) throw errorWithCode('TWELVEDATA_API_KEY_MISSING');
    if (this.#quote && Date.now() - this.#quoteFetchedAt < QUOTE_CACHE_MS) return this.#quote;
    const url = new URL('https://api.twelvedata.com/exchange_rate');
    url.search = new URLSearchParams({ symbol: SYMBOL, apikey: key, timezone: 'UTC' }).toString();
    const quote = quoteFromResponse(await getJson(url, signal), now);
    if (!quote) throw errorWithCode(configuredSpread() == null ? 'PAPER_SPREAD_NOT_CONFIGURED' : 'MARKET_DATA_QUOTE_INVALID');
    this.#quote = quote;
    this.#quoteFetchedAt = Date.now();
    return quote;
  }

  async #readCandles(now, signal) {
    if (this.#candles && Date.now() - this.#candlesFetchedAt < CANDLE_CACHE_MS) return this.#candles;
    const key = apiKey();
    if (!key) throw errorWithCode('TWELVEDATA_API_KEY_MISSING');
    const result = {};
    for (const [timeframe, [interval]] of Object.entries(TIMEFRAMES)) {
      const url = new URL('https://api.twelvedata.com/time_series');
      url.search = new URLSearchParams({ symbol: SYMBOL, interval, outputsize: String(CANDLE_COUNT), timezone: 'UTC', apikey: key }).toString();
      result[timeframe] = candlesFromResponse(await getJson(url, signal), timeframe, now);
    }
    this.#candles = result;
    this.#candlesFetchedAt = Date.now();
    return result;
  }

  async readHealth(now = new Date(), { signal } = {}) {
    if (!apiKey()) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'TWELVEDATA_API_KEY_MISSING' };
    if (configuredSpread() == null) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'PAPER_SPREAD_NOT_CONFIGURED' };
    try {
      const quote = await this.#readQuote(now, signal);
      const ageMs = now.getTime() - Date.parse(quote.observedAt);
      return { source: SOURCE, status: ageMs >= 0 && ageMs <= 30_000 ? 'HEALTHY' : 'STALE', checkedAt: now.toISOString(), reason: ageMs <= 30_000 ? null : 'MARKET_DATA_QUOTE_STALE' };
    } catch (error) {
      return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : 'MARKET_DATA_PROVIDER_ERROR' };
    }
  }

  async readMarketData(now = new Date(), { signal } = {}) {
    const quote = await this.#readQuote(now, signal);
    const candlesByTimeframe = await this.#readCandles(now, signal);
    return {
      source: SOURCE,
      quote,
      candlesByTimeframe,
      paperSpread: { type: 'FIXED_AROUND_MID', price: configuredSpread() },
    };
  }
}
