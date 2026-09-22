import { config } from '../config.mjs';
import { MARKET_QUOTE_MAX_AGE_MS } from '../market-source.mjs';

const SOURCE = 'MARKET_DATA';
const PRIMARY_SYMBOL = 'XAUUSD';
const TIMEFRAMES = Object.freeze({
  M15: ['15min', 15 * 60_000],
  M30: ['30min', 30 * 60_000],
  H1: ['1h', 60 * 60_000],
  H4: ['4h', 4 * 60 * 60_000],
});
// The worker checks health frequently; reuse the provider's latest quote for a
// minute so the Twelve Data credit budget is not consumed by duplicate reads.
const QUOTE_CACHE_MS = 60_000;
const CANDLE_CACHE_MS = 5 * 60_000;
const CANDLE_COUNT = 300;
const DAY_MS = 24 * 60 * 60_000;
const CANDLE_CYCLE_MS = 60_000;
const TIMEFRAME_NAMES = Object.freeze(Object.keys(TIMEFRAMES));

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

function providerSymbol(symbol) {
  const value = String(symbol ?? '').trim().toUpperCase();
  if (value === 'XAUUSD') return 'XAU/USD';
  if (value.length === 6) return value.slice(0, 3) + '/' + value.slice(3);
  throw errorWithCode('MARKET_SYMBOL_INVALID');
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
  if (!response.ok || body?.status === 'error' || body?.code) {
    const providerCode = Number(body?.code);
    if (providerCode === 401 || providerCode === 403) throw errorWithCode('MARKET_DATA_AUTH_ERROR');
    if (providerCode === 429) throw errorWithCode('MARKET_DATA_RATE_LIMITED');
    throw errorWithCode('MARKET_DATA_PROVIDER_ERROR');
  }
  return body;
}

function quoteFromResponse(body, symbol, now) {
  const mid = number(body?.rate ?? body?.price ?? body?.close);
  const observedAt = parseTimestamp(body?.timestamp ?? body?.datetime ?? body?.last_quote_at) ?? now;
  const spread = configuredSpread();
  if (mid == null || mid <= 0 || spread == null) return null;
  const half = spread / 2;
  return {
    symbol,
    source: SOURCE,
    bid: Number((mid - half).toFixed(8)),
    ask: Number((mid + half).toFixed(8)),
    last: mid,
    observedAt: observedAt.toISOString(),
  };
}

function responseForSymbol(body, symbol, symbolCount) {
  const key = providerSymbol(symbol);
  const candidates = [body?.[key], body?.[symbol], body?.data?.[key], body?.data?.[symbol]];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  if (symbolCount === 1 && body && typeof body === 'object' && !Array.isArray(body)) return body;
  return null;
}

function candlesFromResponse(body, symbol, timeframe, now) {
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
      symbol,
      open, high, low, close,
      tickVolume: volume == null || !Number.isInteger(volume) || volume < 0 ? null : volume,
      closedAt: closedAt.toISOString(),
      source: SOURCE,
    };
  }).filter(Boolean).sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}

function marketOverviewFromCandles(symbol, quote, candlesByTimeframe, now) {
  const candles = Array.isArray(candlesByTimeframe?.M15) ? candlesByTimeframe.M15 : [];
  const cutoff = now.getTime() - DAY_MS;
  const last24h = candles.filter((candle) => {
    const closedAt = Date.parse(candle.closedAt ?? '');
    return Number.isFinite(closedAt) && closedAt > cutoff && closedAt <= now.getTime();
  });
  const reference = candles.filter((candle) => {
    const closedAt = Date.parse(candle.closedAt ?? '');
    return Number.isFinite(closedAt) && closedAt <= cutoff;
  }).at(-1) ?? null;
  const last = number(quote?.last);
  const referenceClose = number(reference?.close);
  const change24hPct = last != null && referenceClose != null && referenceClose > 0
    ? Number(((last - referenceClose) / referenceClose * 100).toFixed(4)) : null;
  const highs = last24h.map((candle) => number(candle.high)).filter((value) => value != null);
  const lows = last24h.map((candle) => number(candle.low)).filter((value) => value != null);
  const volumes = last24h.map((candle) => candle.tickVolume);
  const volumeAvailable = volumes.length > 0 && volumes.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0);
  const volume24h = volumeAvailable ? Number(volumes.reduce((sum, value) => sum + Number(value), 0).toFixed(4)) : null;
  return {
    symbol,
    marketType: 'SPOT_OTC',
    source: SOURCE,
    provider: 'TwelveData',
    observedAt: quote?.observedAt ?? null,
    change24hPct,
    high24h: highs.length ? Math.max(...highs) : null,
    low24h: lows.length ? Math.min(...lows) : null,
    volume24h,
    volumeStatus: volumeAvailable ? 'PROVIDER_TICK_VOLUME' : 'UNAVAILABLE_SPOT_VOLUME',
    volumeNote: 'Spot XAU/USD has no single consolidated exchange volume; this is provider tick volume when supplied.',
    derivatives: {
      fundingRate: null,
      openInterest: null,
      status: 'NOT_APPLICABLE',
      reason: 'Funding rate and open interest are not spot XAU/USD fields.',
    },
    history: {
      timeframe: 'M15',
      bars24h: last24h.length,
      referenceClosedAt: reference?.closedAt ?? null,
      status: change24hPct == null ? 'INSUFFICIENT_HISTORY' : 'READY',
    },
  };
}

export class TwelveDataMarketDataProvider {
  #quoteCache = new Map();
  #candleCache = new Map();
  #marketDataRetryAt = 0;
  #lastErrorCode = null;
  #failureCount = 0;
  #lastCandleCycleAt = 0;
  #candleCursor = 0;

  constructor({ symbols = config.symbols } = {}) {
    const normalized = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()))];
    this.symbols = Object.freeze(normalized.includes(PRIMARY_SYMBOL) ? normalized : [PRIMARY_SYMBOL, ...normalized]);
  }

  #recordFailure(error) {
    const code = error?.code ?? 'MARKET_DATA_PROVIDER_ERROR';
    this.#lastErrorCode = code;
    this.#failureCount = Math.min(this.#failureCount + 1, 6);
    const delay = code === 'MARKET_DATA_RATE_LIMITED'
      ? 60_000
      : Math.min(60_000, 5_000 * (2 ** (this.#failureCount - 1)));
    this.#marketDataRetryAt = Date.now() + delay;
  }

  #recordSuccess() {
    this.#failureCount = 0;
    this.#lastErrorCode = null;
    this.#marketDataRetryAt = 0;
  }

  #cachedQuotes(now) {
    const quotes = {};
    for (const symbol of this.symbols) {
      const cached = this.#quoteCache.get(symbol);
      if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_MS) quotes[symbol] = cached.value;
    }
    return quotes;
  }

  async #readQuotes(now, signal) {
    const key = apiKey();
    if (!key) throw errorWithCode('TWELVEDATA_API_KEY_MISSING');
    const cachedQuotes = this.#cachedQuotes(now);
    const missing = this.symbols.filter((symbol) => !cachedQuotes[symbol]);
    if (!missing.length || Date.now() < this.#marketDataRetryAt) return cachedQuotes;
    // Twelve Data accepts comma-separated symbols on currency_conversion. One
    // batched request keeps the four-symbol watchlist within the provider's
    // per-minute budget while preserving one normalized quote per symbol.
    const url = new URL('https://api.twelvedata.com/currency_conversion');
    url.search = new URLSearchParams({ symbol: missing.map(providerSymbol).join(','), amount: '1', apikey: key, timezone: 'UTC' }).toString();
    const body = await getJson(url, signal);
    const quotes = { ...cachedQuotes };
    for (const symbol of missing) {
      const quote = quoteFromResponse(responseForSymbol(body, symbol, missing.length), symbol, now);
      if (quote) {
        this.#quoteCache.set(symbol, { value: quote, fetchedAt: Date.now() });
        quotes[symbol] = quote;
      }
    }
    if (!quotes[PRIMARY_SYMBOL]) throw errorWithCode(configuredSpread() == null ? 'PAPER_SPREAD_NOT_CONFIGURED' : 'MARKET_DATA_QUOTE_INVALID');
    this.#recordSuccess();
    return quotes;
  }

  async #readCandleBatch(timeframe, now, signal) {
    const key = apiKey();
    if (!key) throw errorWithCode('TWELVEDATA_API_KEY_MISSING');
    const definition = TIMEFRAMES[timeframe];
    if (!definition) return;
    const url = new URL('https://api.twelvedata.com/time_series');
    url.search = new URLSearchParams({
      symbol: this.symbols.map(providerSymbol).join(','),
      interval: definition[0],
      outputsize: String(CANDLE_COUNT),
      timezone: 'UTC',
      apikey: key,
    }).toString();
    const body = await getJson(url, signal);
    for (const symbol of this.symbols) {
      const response = responseForSymbol(body, symbol, this.symbols.length);
      const candles = candlesFromResponse(response, symbol, timeframe, now);
      if (!this.#candleCache.has(symbol)) this.#candleCache.set(symbol, new Map());
      if (candles.length) this.#candleCache.get(symbol).set(timeframe, { value: candles, fetchedAt: Date.now() });
    }
    this.#recordSuccess();
  }

  async readHealth(now = new Date(), { signal } = {}) {
    if (!apiKey()) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'TWELVEDATA_API_KEY_MISSING' };
    if (configuredSpread() == null) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'PAPER_SPREAD_NOT_CONFIGURED' };
    try {
      const quote = (await this.#readQuotes(now, signal))[PRIMARY_SYMBOL];
      if (!quote) throw errorWithCode('MARKET_DATA_QUOTE_INVALID');
      const ageMs = now.getTime() - Date.parse(quote.observedAt);
      return { source: SOURCE, status: ageMs >= 0 && ageMs <= MARKET_QUOTE_MAX_AGE_MS ? 'HEALTHY' : 'STALE', checkedAt: now.toISOString(), reason: ageMs <= MARKET_QUOTE_MAX_AGE_MS ? null : 'MARKET_DATA_QUOTE_STALE' };
    } catch (error) {
      this.#recordFailure(error);
      return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : 'MARKET_DATA_PROVIDER_ERROR' };
    }
  }

  async readMarketData(now = new Date(), { signal } = {}) {
    let quotesBySymbol;
    const errors = [];
    try {
      quotesBySymbol = await this.#readQuotes(now, signal);
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
    if (Date.now() - this.#lastCandleCycleAt >= CANDLE_CYCLE_MS && Date.now() >= this.#marketDataRetryAt) {
      const timeframe = TIMEFRAME_NAMES[this.#candleCursor % TIMEFRAME_NAMES.length];
      this.#candleCursor += 1;
      this.#lastCandleCycleAt = Date.now();
      try {
        await this.#readCandleBatch(timeframe, now, signal);
      } catch (error) {
        this.#recordFailure(error);
        errors.push({ symbol: PRIMARY_SYMBOL, reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? '') ? error.code : 'MARKET_DATA_PROVIDER_ERROR' });
      }
    }
    const candlesBySymbol = {};
    const marketOverviewBySymbol = {};
    for (const symbol of this.symbols) {
      const cache = this.#candleCache.get(symbol) ?? new Map();
      candlesBySymbol[symbol] = Object.fromEntries([...cache.entries()].map(([timeframe, item]) => [timeframe, item.value]));
      if (!quotesBySymbol[symbol]) errors.push({ symbol, reason: this.#lastErrorCode ?? 'MARKET_DATA_QUOTE_UNAVAILABLE' });
      if (quotesBySymbol[symbol]) marketOverviewBySymbol[symbol] = marketOverviewFromCandles(symbol, quotesBySymbol[symbol], candlesBySymbol[symbol], now);
    }
    if (!quotesBySymbol[PRIMARY_SYMBOL]) throw errorWithCode(this.#lastErrorCode ?? 'MARKET_DATA_QUOTE_UNAVAILABLE');
    return {
      source: SOURCE,
      symbols: this.symbols,
      quote: quotesBySymbol[PRIMARY_SYMBOL] ?? null,
      candlesByTimeframe: candlesBySymbol[PRIMARY_SYMBOL] ?? {},
      quotesBySymbol,
      candlesBySymbol,
      marketOverview: marketOverviewBySymbol[PRIMARY_SYMBOL] ?? null,
      marketOverviewBySymbol,
      errors,
      paperSpread: { type: 'FIXED_AROUND_MID', price: configuredSpread() },
    };
  }
}
