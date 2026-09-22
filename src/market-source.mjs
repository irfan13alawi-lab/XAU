export const ACCEPTED_MARKET_SOURCES = Object.freeze(new Set(['BROKER', 'MARKET_DATA']));

// Twelve Data's commodity conversion feed can publish a valid latest rate a
// few minutes apart. Keep a bounded five-minute window for paper testing while
// still failing closed on older data instead of inventing a quote.
export const MARKET_QUOTE_MAX_AGE_MS = 5 * 60_000;

export function isAcceptedMarketSource(value) {
  return ACCEPTED_MARKET_SOURCES.has(String(value ?? '').trim().toUpperCase());
}

export function isFreshMarketSnapshot(value) {
  const source = String(value?.source ?? '').trim().toUpperCase();
  return isAcceptedMarketSource(source)
    && (value?.status === source || (source === 'MARKET_DATA' && value?.status === 'BROKER'));
}

