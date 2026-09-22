import assert from 'node:assert/strict';
import { test } from 'node:test';

function candleRows(now, intervalMinutes, count, volume = true) {
  const intervalMs = intervalMinutes * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const startedAt = now.getTime() - intervalMs * (index + 1);
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
