import assert from 'node:assert/strict';
import { test } from 'node:test';

function candleRows(now, intervalMinutes, count, volume = true) {
  const intervalMs = intervalMinutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const startedAt = now.getTime() - intervalMs * (index + 1) - 5 * 60_000;
    const close = 2000 + (count - index) * 0.25;
    return {
      datetime: new Date(startedAt).toISOString().replace('T', ' ').replace('.000Z', ''),
      open: (close - 0.2).toFixed(2),
      high: (close + 0.3).toFixed(2),
      low: (close - 0.4).toFixed(2),
      close: close.toFixed(2),
      ...(volume ? { volume: String(100 + index) } : {}),
    };
  }).reverse();
}

test('Twelve Data adapter returns a VPS-safe XAU market contract with spot derivative fields explicit', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ rate: '2030.50', timestamp: Math.floor(now.getTime() / 1000) }), { status: 200 });
    }
    const interval = url.searchParams.get('interval');
    const intervals = { '15min': 15, '30min': 30, '1h': 60, '4h': 240 };
    return new Response(JSON.stringify({ values: candleRows(now, intervals[interval], interval === '15min' ? 120 : 16) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'] });
    const payload = await provider.readMarketData(now);
    assert.equal(payload.source, 'MARKET_DATA');
    assert.equal(payload.quote.symbol, 'XAUUSD');
    assert.ok(Number.isFinite(payload.marketOverview.change24hPct));
    assert.ok(Number.isFinite(payload.marketOverview.high24h));
    assert.ok(Number.isFinite(payload.marketOverview.low24h));
    assert.ok(Number.isFinite(payload.marketOverview.volume24h));
    assert.equal(payload.marketOverview.volumeStatus, 'PROVIDER_TICK_VOLUME');
    assert.equal(payload.marketOverview.derivatives.fundingRate, null);
    assert.equal(payload.marketOverview.derivatives.openInterest, null);
    assert.equal(payload.marketOverview.derivatives.status, 'NOT_APPLICABLE');
    assert.equal(payload.instrumentMetadata.tickSize, 0.01);
    assert.equal(payload.paperCosts.minimumLot, 0.01);
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('Twelve Data adapter batches the four-symbol watchlist and advances one candle timeframe per cycle', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  const symbols = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify(Object.fromEntries(symbols.map((symbol, index) => [symbol, {
        rate: String(2000 + index), timestamp: Math.floor(now.getTime() / 1000),
      }]))), { status: 200 });
    }
    const values = candleRows(now, 15, 120);
    return new Response(JSON.stringify(Object.fromEntries(symbols.map((symbol) => [symbol, { values }]))), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'] });
    const payload = await provider.readMarketData(now);
    assert.deepEqual(Object.keys(payload.quotesBySymbol).sort(), ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']);
    assert.deepEqual(Object.keys(payload.candlesBySymbol).sort(), ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']);
    for (const symbol of ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']) {
      assert.equal(payload.candlesBySymbol[symbol].M15.length, 120);
      assert.equal(payload.persistCandlesBySymbol[symbol].M15.length, 120);
    }
    const cached = await provider.readMarketData(new Date(now.getTime() + 15_000));
    assert.equal(cached.persistCandlesBySymbol.XAUUSD.M15.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('health keeps the last complete quote set during a partial background refresh', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  const symbols = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
  let backgroundTick = null;
  let blockRefresh = false;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  globalThis.setInterval = (callback) => {
    backgroundTick = callback;
    return { unref() {} };
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (blockRefresh && url.pathname.endsWith('/currency_conversion')) await refreshGate;
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify(Object.fromEntries(symbols.map((symbol, index) => [symbol.replace(/(XAU|EUR|GBP|USD)(USD|JPY)/, '$1/$2'), {
        rate: String(2000 + index), timestamp: Math.floor(now.getTime() / 1000),
      }]))), { status: 200 });
    }
    return new Response(JSON.stringify({ values: candleRows(now, 15, 120) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols });
    await provider.readMarketData(now);
    const initialHealth = await provider.readHealth(now);
    assert.equal(initialHealth.status, 'HEALTHY');
    await new Promise((resolve) => setTimeout(resolve, 10));
    blockRefresh = true;
    backgroundTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duringRefresh = await provider.readHealth(new Date(now.getTime() + 15_000));
    assert.equal(duringRefresh.status, 'HEALTHY');
    releaseRefresh();
    provider.stop();
  } finally {
    releaseRefresh();
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousSetInterval;
  }
});

test('background refresh aborts a stalled provider request and can recover on the next cycle', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  let backgroundTick = null;
  let stalled = false;
  globalThis.setInterval = (callback) => {
    backgroundTick = callback;
    return { unref() {} };
  };
  globalThis.fetch = async (input, { signal } = {}) => {
    if (stalled) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ rate: '2030.50', timestamp: Math.floor(now.getTime() / 1000) }), { status: 200 });
    }
    return new Response(JSON.stringify({ values: candleRows(now, 15, 120) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'], backgroundRefreshTimeoutMs: 20 });
    await provider.readMarketData(now);
    await provider.readHealth(now);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stalled = true;
    backgroundTick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    stalled = false;
    backgroundTick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovered = await provider.readHealth(new Date(now.getTime() + 15_000));
    assert.equal(recovered.status, 'HEALTHY');
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
    globalThis.setInterval = previousSetInterval;
  }
});

test('market feed rejects a wrong-symbol primary quote instead of accepting a cross-symbol price', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({
        'XAU/USD': { symbol: 'EUR/USD', rate: '1.13707', timestamp: Math.floor(now.getTime() / 1000) },
        'EUR/USD': { symbol: 'EUR/USD', rate: '1.13707', timestamp: Math.floor(now.getTime() / 1000) },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ values: candleRows(now, 15, 120) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD', 'EURUSD'] });
    await assert.rejects(
      () => provider.readMarketData(now),
      (error) => ['MARKET_DATA_SYMBOLS_INCOMPLETE', 'MARKET_DATA_QUOTE_INVALID'].includes(error.code),
    );
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('market feed fails closed when an unlabelled quote is outside the verified candle range', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ rate: '1.13707', timestamp: Math.floor(now.getTime() / 1000) }), { status: 200 });
    }
    return new Response(JSON.stringify({ values: candleRows(now, 15, 120) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'] });
    await assert.rejects(
      () => provider.readMarketData(now),
      (error) => error.code === 'MARKET_DATA_SYMBOLS_INCOMPLETE',
    );
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('Twelve Data adapter refreshes cached candle timeframes instead of freezing the first M15 batch', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  let clock = previousNow();
  Date.now = () => clock;
  let candleRequests = 0;
  let backgroundTick = null;
  const previousSetInterval = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    backgroundTick = callback;
    return { unref() {} };
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ rate: '2030.50', timestamp: Math.floor(clock / 1000) }), { status: 200 });
    }
    candleRequests += 1;
    const interval = url.searchParams.get('interval');
    const minutes = { '15min': 15, '30min': 30, '1h': 60, '4h': 240 }[interval];
    const values = candleRows(new Date(clock), minutes, 120).map((row) => ({
      ...row,
      close: (Number(row.close) + candleRequests).toFixed(2),
    }));
    return new Response(JSON.stringify({ values }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'] });
    const first = await provider.readMarketData(new Date(clock));
    const firstM15ClosedAt = first.candlesBySymbol.XAUUSD.M15.at(-1).closedAt;
    const firstM15Close = first.candlesBySymbol.XAUUSD.M15.at(-1).close;
    await provider.readHealth(new Date(clock));
    assert.equal(typeof backgroundTick, 'function');
    for (let cycle = 0; cycle < 4; cycle += 1) {
      clock += 2 * 60_000 + 1;
      backgroundTick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const refreshed = await provider.readMarketData(new Date(clock));
    const refreshedM15ClosedAt = refreshed.candlesBySymbol.XAUUSD.M15.at(-1).closedAt;
    assert.equal(candleRequests, 5, 'initial M15 plus one request for each rotated timeframe');
    assert.notEqual(refreshedM15ClosedAt, firstM15ClosedAt);
    assert.notEqual(refreshed.candlesBySymbol.XAUUSD.M15.at(-1).close, firstM15Close);
    provider.stop();
  } finally {
    Date.now = previousNow;
    globalThis.setInterval = previousSetInterval;
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('provider priming stays off the worker health tick while the first quote is pending', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async (input) => {
    await fetchGate;
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ rate: '2030.50', timestamp: Math.floor(now.getTime() / 1000) }), { status: 200 });
    }
    return new Response(JSON.stringify({ values: candleRows(now, 15, 120) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'] });
    provider.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const health = await Promise.race([
      provider.readHealth(now),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 100)),
    ]);
    assert.notEqual(health, 'TIMEOUT');
    assert.equal(health.status, 'OFFLINE');
    provider.stop();
  } finally {
    releaseFetch();
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('Twelve Data adapter accepts array and nested-data batch response shapes', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  const symbols = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/currency_conversion')) {
      return new Response(JSON.stringify({ data: symbols.map((symbol, index) => ({ symbol, rate: String(2000 + index), timestamp: Math.floor(now.getTime() / 1000) })) }), { status: 200 });
    }
    const interval = url.searchParams.get('interval');
    const minutes = { '15min': 15, '30min': 30, '1h': 60, '4h': 240 }[interval];
    return new Response(JSON.stringify({ data: Object.fromEntries(symbols.map((symbol) => [symbol, { data: { values: candleRows(now, minutes, 120) } }])) }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'] });
    const payload = await provider.readMarketData(now);
    assert.deepEqual(Object.keys(payload.quotesBySymbol).sort(), ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']);
    for (const symbol of ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']) assert.equal(payload.candlesBySymbol[symbol].M15.length, 120);
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('Twelve Data adapter falls back to a single quote when a batch response omits XAUUSD', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  let calls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    calls += 1;
    if (url.pathname.endsWith('/currency_conversion')) {
      if (url.searchParams.get('symbol')?.includes(',')) {
        return new Response(JSON.stringify({ 'EUR/USD': { rate: '1.08', timestamp: Math.floor(now.getTime() / 1000) } }), { status: 200 });
      }
      return new Response(JSON.stringify({ rate: '2030.50', timestamp: Math.floor(now.getTime() / 1000) }), { status: 200 });
    }
    return new Response(JSON.stringify({ values: [] }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD', 'EURUSD'] });
    const health = await provider.readHealth(now);
    assert.equal(health.status, 'HEALTHY');
    assert.equal(calls, 2);
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('Twelve Data adapter uses Swissquote read-only quotes when Twelve Data has no quote value', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'forex-data-feed.swissquote.com') {
      return new Response(JSON.stringify([{ ts: Math.floor(now.getTime() / 1000), spreadProfilePrices: [{ bid: '2030.00', ask: '2030.40' }] }]), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols: ['XAUUSD'] });
    const health = await provider.readHealth(now);
    assert.equal(health.status, 'HEALTHY');
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});

test('market feed bypasses a Twelve Data rate limit with Biquote quotes and closed candles', async () => {
  const previousKey = process.env.NEXORA_TWELVEDATA_API_KEY;
  const previousSpread = process.env.NEXORA_PAPER_SPREAD_PRICE;
  const previousFetch = globalThis.fetch;
  process.env.NEXORA_TWELVEDATA_API_KEY = 'test-key-not-a-credential';
  process.env.NEXORA_PAPER_SPREAD_PRICE = '0.20';
  const now = new Date('2026-09-22T00:00:00.000Z');
  const symbols = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
  const biquoteRows = Array.from({ length: 120 }, (_, index) => ({
    openTime: new Date(now.getTime() - (index + 2) * 15 * 60_000).toISOString(),
    open: 2000 + index,
    high: 2001 + index,
    low: 1999 + index,
    close: 2000.5 + index,
    tickVolume: 100 + index,
    isOpen: false,
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'api.twelvedata.com') return new Response(JSON.stringify({ code: 429, status: 'error' }), { status: 200 });
    if (url.hostname === 'forex-data-feed.swissquote.com') return new Response(JSON.stringify([]), { status: 200 });
    if (url.hostname === 'biquote.io' && url.pathname.endsWith('/ohlc')) return new Response(JSON.stringify({ bars: biquoteRows }), { status: 200 });
    const symbol = url.pathname.split('/').at(-1);
    const index = symbols.indexOf(symbol);
    return new Response(JSON.stringify({ symbol, bid: 2000 + index, ask: 2000.1 + index, mid: 2000.05 + index, timestamp: now.toISOString(), stale: false }), { status: 200 });
  };
  try {
    const { TwelveDataMarketDataProvider } = await import('../src/providers/twelvedata-market-provider.mjs');
    const provider = new TwelveDataMarketDataProvider({ symbols });
    const payload = await provider.readMarketData(now);
    assert.deepEqual(Object.keys(payload.quotesBySymbol).sort(), symbols.slice().sort());
    for (const symbol of symbols) assert.equal(payload.candlesBySymbol[symbol].M15.length, 120);
    assert.equal(payload.quote.bid, 2000);
    assert.equal(payload.quote.ask, 2000.1);
    assert.equal(payload.marketOverview.provider, 'Biquote');
    provider.stop();
  } finally {
    if (previousKey === undefined) delete process.env.NEXORA_TWELVEDATA_API_KEY;
    else process.env.NEXORA_TWELVEDATA_API_KEY = previousKey;
    if (previousSpread === undefined) delete process.env.NEXORA_PAPER_SPREAD_PRICE;
    else process.env.NEXORA_PAPER_SPREAD_PRICE = previousSpread;
    globalThis.fetch = previousFetch;
  }
});
