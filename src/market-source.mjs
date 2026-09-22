export const ACCEPTED_MARKET_SOURCES = Object.freeze(new Set(['BROKER', 'MARKET_DATA']));

// Twelve Data exchange-rate timestamps are emitted at minute granularity. A
// 30-second gate rejects an otherwise current quote during the second half of
// every minute, so the paper feed allows one full provider update interval
// plus a small network/worker cushion while still failing closed on older data.
export const MARKET_QUOTE_MAX_AGE_MS = 90_000;

export function isAcceptedMarketSource(value) {
  return ACCEPTED_MARKET_SOURCES.has(String(value ?? '').trim().toUpperCase());
}

export function isFreshMarketSnapshot(value) {
  const source = String(value?.source ?? '').trim().toUpperCase();
  return isAcceptedMarketSource(source) && value?.status === source;
}

