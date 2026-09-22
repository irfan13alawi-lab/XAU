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
// The worker checks health every 15 seconds. The background feed refreshes
// quotes every two minutes, so worker ticks must reuse the cache instead of
// turning provider I/O into recurring latency spikes.
const QUOTE_CACHE_MS = 5 * 60_000;
const CANDLE_CACHE_MS = 5 * 60_000;
const CANDLE_COUNT = 300;
const DAY_MS = 24 * 60 * 60_000;
// Quotes and one candle timeframe refresh in the background every two minutes.
// Rotating four timeframes keeps M15 comfortably inside its freshness window
// while leaving headroom under Twelve Data's per-minute credit limit.
const CANDLE_CYCLE_MS = 2 * 60_000;
const CANDLE_SETTLE_DELAY_MS = 2 * 60_000;
const TIMEFRAME_NAMES = Object.freeze(Object.keys(TIMEFRAMES));

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = number(value);
  return parsed != null && parsed > 0;
}

function apiKey() {
  return String(process.env.NEXORA_TWELVEDATA_API_KEY ?? '').trim();
}

function configuredSpread() {
  const spread = number(process.env.NEXORA_PAPER_SPREAD_PRICE);
  return spread != null && spread > 0 ? spread : null;
}

function paperInstrumentMetadata(symbol) {
  const normalized = String(symbol).toUpperCase();
  const specs = {
    XAUUSD: { contractSize: 100, tickSize: 0.01, tickValue: 1, minLot: 0.01, lotStep: 0.01, maxLot: 100, digits: 2, minStopDistance: 0.1, tickValueCurrency: 'USD', quoteCurrency: 'USD' },
    EURUSD: { contractSize: 100000, tickSize: 0.00001, tickValue: 1, minLot: 0.01, lotStep: 0.01, maxLot: 100, digits: 5, minStopDistance: 0.0001, tickValueCurrency: 'USD', quoteCurrency: 'USD' },
    GBPUSD: { contractSize: 100000, tickSize: 0.00001, tickValue: 1, minLot: 0.01, lotStep: 0.01, maxLot: 100, digits: 5, minStopDistance: 0.0001, tickValueCurrency: 'USD', quoteCurrency: 'USD' },
    USDJPY: { contractSize: 100000, tickSize: 0.001, tickValue: 0.64, minLot: 0.01, lotStep: 0.01, maxLot: 100, digits: 3, minStopDistance: 0.01, tickValueCurrency: 'USD', quoteCurrency: 'JPY' },
  };
  const spec = specs[normalized] ?? specs.XAUUSD;
  return { symbol: normalized, source: 'PAPER_SIMULATION_ASSUMPTION', marketType: normalized === 'XAUUSD' ? 'SPOT_OTC' : 'FOREX_SPOT', ...spec };
}

function paperExecutionCosts(symbol) {
  const instrument = paperInstrumentMetadata(symbol);
  return {
    source: 'PAPER_SIMULATION_ASSUMPTION',
    symbol: instrument.symbol,
    accountCurrency: 'USD',
    contractSize: instrument.contractSize,
    quoteToAccountRate: 1,
    lotStep: instrument.lotStep,
    minimumLot: instrument.minLot,
    breakEvenOffsetPrice: 0,
    fillLatencyMs: 0,
    slippagePrice: 0,
    commissionPerLot: 0,
    swapPerLotPerDay: 0,
    fillRatio: 1,
  };
}

function providerSymbol(symbol) {
  const value = String(symbol ?? '').trim().toUpperCase();
  if (value === 'XAUUSD') return 'XAU/USD';
  if (value.length === 6) return value.slice(0, 3) + '/' + value.slice(3);
  throw errorWithCode('MARKET_SYMBOL_INVALID');
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value > 1_000_000_000_000 ? value : value * 1000);
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
  const payload = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const mid = number(payload?.rate ?? payload?.value ?? payload?.price ?? payload?.close);
  const observedAt = parseTimestamp(payload?.timestamp ?? payload?.datetime ?? payload?.last_quote_at) ?? now;
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

function swissquoteInstrument(symbol) {
  const value = providerSymbol(symbol);
  return value;
}

function quoteFromSwissquote(body, symbol, now) {
  const rows = Array.isArray(body) ? body : [];
  const prices = rows.flatMap((row) => Array.isArray(row?.spreadProfilePrices) ? row.spreadProfilePrices : []);
  const selected = prices.find((item) => positive(item?.bid) && positive(item?.ask) && Number(item.ask) >= Number(item.bid));
  if (!selected) return null;
  const mid = (Number(selected.bid) + Number(selected.ask)) / 2;
  const observedAt = parseTimestamp(rows.map((row) => row?.ts).find((value) => value != null)) ?? now;
  const spread = configuredSpread();
  if (!Number.isFinite(mid) || mid <= 0 || spread == null) return null;
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

function quoteFromBiquote(body, symbol, now) {
  const bid = number(body?.bid);
  const ask = number(body?.ask);
  const mid = number(body?.mid) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
  const observedAt = parseTimestamp(body?.timestamp ?? body?.lastQuoteAt) ?? now;
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

function normalizedSymbol(value) {
  return String(value ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function responseForSymbol(body, symbol, symbolCount) {
  const wanted = normalizedSymbol(providerSymbol(symbol));
  const containers = [body, body?.data, body?.results, body?.result];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    if (Array.isArray(container)) {
      const match = container.find((item) => normalizedSymbol(item?.symbol ?? item?.meta?.symbol) === wanted);
      if (match && typeof match === 'object') return match;
      continue;
    }
    const directKeys = [providerSymbol(symbol), symbol, wanted];
    for (const key of directKeys) {
      const candidate = container[key];
      if (candidate && typeof candidate === 'object') return candidate;
    }
    for (const [entryKey, entryValue] of Object.entries(container)) {
      if (normalizedSymbol(entryKey) === wanted && entryValue && typeof entryValue === 'object') return entryValue;
      if (entryValue && typeof entryValue === 'object' && normalizedSymbol(entryValue.symbol ?? entryValue.meta?.symbol) === wanted) return entryValue;
    }
  }
  if (symbolCount === 1 && body && typeof body === 'object' && !Array.isArray(body)) return body;
  return null;
}

function candlesFromResponse(body, symbol, timeframe, now) {
  const definition = TIMEFRAMES[timeframe];
  const payload = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  const rows = Array.isArray(payload?.values) ? payload.values : [];
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
    if (![open, high, low, close].every((value) => value != null)
      || closedAt.getTime() > now.getTime() - CANDLE_SETTLE_DELAY_MS) return null;
    return {
      symbol,
      open, high, low, close,
      tickVolume: volume == null || !Number.isInteger(volume) || volume < 0 ? null : volume,
      closedAt: closedAt.toISOString(),
      source: SOURCE,
    };
  }).filter(Boolean).sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}

function marketOverviewFromCandles(symbol, quote, candlesByTimeframe, now, providerName = 'TwelveData') {
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
    provider: providerName,
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
  #lastEmittedCandleAt = new Map();
  #quoteNetworkAttempted = false;
  #backgroundTimer = null;
  #backgroundRefreshInFlight = false;

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

  async #readQuotes(now, signal, { force = false } = {}) {
    const key = apiKey();
    const cachedQuotes = this.#cachedQuotes(now);
    const missing = force ? this.symbols : this.symbols.filter((symbol) => !cachedQuotes[symbol]);
    if (!missing.length) return cachedQuotes;
    // After the initial hydration, health checks must never become a network
    // reconnect loop. The background feed owns refreshes; an expired cache
    // therefore fails closed quickly until that feed succeeds again.
    if (!force && this.#quoteNetworkAttempted) return cachedQuotes;
    if (!force) this.#quoteNetworkAttempted = true;
    const twelveDataAllowed = Boolean(key) && Date.now() >= this.#marketDataRetryAt;
    // Twelve Data accepts comma-separated symbols on currency_conversion. One
    // batched request keeps the four-symbol watchlist within the provider's
    // per-minute budget while preserving one normalized quote per symbol.
    const quotes = { ...cachedQuotes };
    let fallbackError = key ? null : errorWithCode('TWELVEDATA_API_KEY_MISSING');
    if (twelveDataAllowed) {
      const url = new URL('https://api.twelvedata.com/currency_conversion');
      url.search = new URLSearchParams({ symbol: missing.map(providerSymbol).join(','), amount: '1', apikey: key, timezone: 'UTC' }).toString();
      try {
        const body = await getJson(url, signal);
        for (const symbol of missing) {
          const quote = quoteFromResponse(responseForSymbol(body, symbol, missing.length), symbol, now);
          if (quote) {
            this.#quoteCache.set(symbol, { value: quote, fetchedAt: Date.now() });
            quotes[symbol] = quote;
          }
        }
      } catch (error) {
        fallbackError = error;
        this.#recordFailure(error);
      }
    }
    const unresolved = missing.filter((symbol) => !quotes[symbol]);
    if (twelveDataAllowed && fallbackError?.code !== 'MARKET_DATA_RATE_LIMITED') for (const symbol of unresolved) {
      for (const endpoint of ['currency_conversion', 'price', 'quote']) {
        try {
          const singleUrl = new URL(`https://api.twelvedata.com/${endpoint}`);
          singleUrl.search = new URLSearchParams({ symbol: providerSymbol(symbol), amount: '1', apikey: key, timezone: 'UTC' }).toString();
          const singleBody = await getJson(singleUrl, signal);
          const quote = quoteFromResponse(responseForSymbol(singleBody, symbol, 1), symbol, now);
          if (!quote) throw errorWithCode('MARKET_DATA_QUOTE_INVALID');
          this.#quoteCache.set(symbol, { value: quote, fetchedAt: Date.now() });
          quotes[symbol] = quote;
          fallbackError = null;
          break;
        } catch (error) {
          fallbackError = error;
        }
      }
    }
    const biquoteUnresolved = missing.filter((symbol) => !quotes[symbol]);
    for (const symbol of biquoteUnresolved) {
      try {
        const body = await getJson(`https://biquote.io/api/${normalizedSymbol(symbol)}?allowStale=false`, signal);
        const quote = quoteFromBiquote(body, symbol, now);
        if (!quote) throw errorWithCode('MARKET_DATA_QUOTE_INVALID');
        this.#quoteCache.set(symbol, { value: quote, fetchedAt: Date.now() });
        quotes[symbol] = quote;
      } catch (error) {
        fallbackError = error;
      }
    }
    const swissquoteUnresolved = missing.filter((symbol) => !quotes[symbol]);
    for (const symbol of swissquoteUnresolved) {
      try {
        const url = `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${swissquoteInstrument(symbol)}`;
        const body = await getJson(url, signal);
        const quote = quoteFromSwissquote(body, symbol, now);
        if (!quote) throw errorWithCode('MARKET_DATA_QUOTE_INVALID');
        this.#quoteCache.set(symbol, { value: quote, fetchedAt: Date.now() });
        quotes[symbol] = quote;
      } catch (error) {
        fallbackError = error;
      }
    }
    if (!quotes[PRIMARY_SYMBOL]) throw fallbackError ?? errorWithCode(configuredSpread() == null ? 'PAPER_SPREAD_NOT_CONFIGURED' : 'MARKET_DATA_QUOTE_INVALID');
    this.#recordSuccess();
    return quotes;
  }

  async #readCandleBatch(timeframe, now, signal) {
    const key = apiKey();
    const definition = TIMEFRAMES[timeframe];
    if (!definition) return;
    let twelveDataError = null;
    if (key && Date.now() >= this.#marketDataRetryAt) {
      const url = new URL('https://api.twelvedata.com/time_series');
      url.search = new URLSearchParams({
        symbol: this.symbols.map(providerSymbol).join(','),
        interval: definition[0],
        outputsize: String(CANDLE_COUNT),
        timezone: 'UTC',
        apikey: key,
      }).toString();
      try {
        const body = await getJson(url, signal);
        for (const symbol of this.symbols) {
          const response = responseForSymbol(body, symbol, this.symbols.length);
          const candles = candlesFromResponse(response, symbol, timeframe, now);
          if (!this.#candleCache.has(symbol)) this.#candleCache.set(symbol, new Map());
          if (candles.length) this.#candleCache.get(symbol).set(timeframe, { value: candles, fetchedAt: Date.now(), provider: 'TwelveData' });
        }
      } catch (error) {
        twelveDataError = error;
        this.#recordFailure(error);
      }
    }
    for (const symbol of this.symbols) {
      const cached = this.#candleCache.get(symbol)?.get(timeframe);
      if (cached?.value?.length) continue;
      try {
        const biquoteInterval = ({ '15min': '15m', '30min': '30m', '1h': '1h', '4h': '4h' })[definition[0]];
        const body = await getJson(`https://biquote.io/api/${normalizedSymbol(symbol)}/ohlc?interval=${biquoteInterval}&limit=${CANDLE_COUNT}`, signal);
        const candles = biquoteCandlesFromResponse(body, symbol, timeframe, now);
        if (!this.#candleCache.has(symbol)) this.#candleCache.set(symbol, new Map());
        if (candles.length) this.#candleCache.get(symbol).set(timeframe, { value: candles, fetchedAt: Date.now(), provider: 'Biquote' });
      } catch (error) {
        twelveDataError = error;
      }
    }
    if (![...this.#candleCache.values()].some((timeframes) => timeframes.get(timeframe)?.value?.length)) {
      throw twelveDataError ?? errorWithCode('MARKET_DATA_CANDLE_INVALID');
    }
    this.#recordSuccess();
  }

  #startBackgroundFeed() {
    if (this.#backgroundTimer || !apiKey() || configuredSpread() == null) return;
    this.#backgroundTimer = setInterval(() => { void this.#refreshBackgroundFeed(); }, CANDLE_CYCLE_MS);
    this.#backgroundTimer.unref?.();
  }

  async #refreshBackgroundFeed() {
    if (this.#backgroundRefreshInFlight) return;
    this.#backgroundRefreshInFlight = true;
    const now = new Date();
    try {
      try {
        await this.#readQuotes(now, undefined, { force: true });
      } catch (error) {
        this.#recordFailure(error);
      }
      if (Date.now() - this.#lastCandleCycleAt >= CANDLE_CYCLE_MS) {
        const timeframe = TIMEFRAME_NAMES[this.#candleCursor % TIMEFRAME_NAMES.length];
        this.#candleCursor += 1;
        this.#lastCandleCycleAt = Date.now();
        try {
          await this.#readCandleBatch(timeframe, now);
        } catch (error) {
          this.#recordFailure(error);
        }
      }
    } finally {
      this.#backgroundRefreshInFlight = false;
    }
  }

  async readHealth(now = new Date(), { signal } = {}) {
    if (!apiKey()) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'TWELVEDATA_API_KEY_MISSING' };
    if (configuredSpread() == null) return { source: SOURCE, status: 'OFFLINE', checkedAt: now.toISOString(), reason: 'PAPER_SPREAD_NOT_CONFIGURED' };
    this.#startBackgroundFeed();
    try {
      let quotes = this.#cachedQuotes(now);
      if (!quotes[PRIMARY_SYMBOL]) quotes = await this.#readQuotes(now, signal);
      const quote = quotes[PRIMARY_SYMBOL];
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
      quotesBySymbol = this.#cachedQuotes(now);
      if (!quotesBySymbol[PRIMARY_SYMBOL]) quotesBySymbol = await this.#readQuotes(now, signal);
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
    const hasCachedCandles = [...this.#candleCache.values()].some((timeframes) => timeframes.size > 0);
    if (!hasCachedCandles) {
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
    const persistCandlesBySymbol = {};
    const marketOverviewBySymbol = {};
    for (const symbol of this.symbols) {
      const cache = this.#candleCache.get(symbol) ?? new Map();
      const candleProviders = new Set();
      for (const item of cache.values()) if (item.provider) candleProviders.add(item.provider);
      candlesBySymbol[symbol] = Object.fromEntries([...cache.entries()].map(([timeframe, item]) => [timeframe, item.value]));
      persistCandlesBySymbol[symbol] = {};
      for (const [timeframe, item] of cache.entries()) {
        const latest = item.value.at(-1)?.closedAt ?? null;
        const emissionKey = symbol + ':' + timeframe;
        const previous = this.#lastEmittedCandleAt.get(emissionKey);
        persistCandlesBySymbol[symbol][timeframe] = previous
          ? item.value.filter((candle) => Date.parse(candle.closedAt) > Date.parse(previous))
          : item.value;
        if (latest) this.#lastEmittedCandleAt.set(emissionKey, latest);
      }
      if (!quotesBySymbol[symbol]) errors.push({ symbol, reason: this.#lastErrorCode ?? 'MARKET_DATA_QUOTE_UNAVAILABLE' });
      if (quotesBySymbol[symbol]) marketOverviewBySymbol[symbol] = marketOverviewFromCandles(
        symbol,
        quotesBySymbol[symbol],
        candlesBySymbol[symbol],
        now,
        [...candleProviders].join(' + ') || 'TwelveData',
      );
    }
    if (!quotesBySymbol[PRIMARY_SYMBOL]) throw errorWithCode(this.#lastErrorCode ?? 'MARKET_DATA_QUOTE_UNAVAILABLE');
    return {
      source: SOURCE,
      symbols: this.symbols,
      quote: quotesBySymbol[PRIMARY_SYMBOL] ?? null,
      candlesByTimeframe: candlesBySymbol[PRIMARY_SYMBOL] ?? {},
      quotesBySymbol,
      candlesBySymbol,
      persistCandlesBySymbol,
      marketOverview: marketOverviewBySymbol[PRIMARY_SYMBOL] ?? null,
      marketOverviewBySymbol,
      errors,
      paperSpread: { type: 'FIXED_AROUND_MID', price: configuredSpread() },
      instrumentMetadata: paperInstrumentMetadata(PRIMARY_SYMBOL),
      instrumentMetadataBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, paperInstrumentMetadata(symbol)])),
      paperCosts: paperExecutionCosts(PRIMARY_SYMBOL),
      paperCostsBySymbol: Object.fromEntries(this.symbols.map((symbol) => [symbol, paperExecutionCosts(symbol)])),
    };
  }

  stop() {
    if (this.#backgroundTimer) clearInterval(this.#backgroundTimer);
    this.#backgroundTimer = null;
  }
}

function biquoteCandlesFromResponse(body, symbol, timeframe, now) {
  const definition = TIMEFRAMES[timeframe];
  const rows = Array.isArray(body?.bars) ? body.bars : [];
  const intervalMs = definition?.[1];
  if (!intervalMs) return [];
  return rows.map((row) => {
    const startedAt = parseTimestamp(row?.openTime);
    if (!startedAt || row?.isOpen === true) return null;
    const closedAt = new Date(startedAt.getTime() + intervalMs);
    const open = number(row?.open);
    const high = number(row?.high);
    const low = number(row?.low);
    const close = number(row?.close);
    const volume = row?.tickVolume ?? row?.volume;
    if (![open, high, low, close].every((value) => value != null)
      || closedAt.getTime() > now.getTime() - CANDLE_SETTLE_DELAY_MS) return null;
    return {
      symbol,
      open, high, low, close,
      tickVolume: volume == null || !Number.isInteger(Number(volume)) || Number(volume) < 0 ? null : Number(volume),
      closedAt: closedAt.toISOString(),
      source: SOURCE,
    };
  }).filter(Boolean).sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}
