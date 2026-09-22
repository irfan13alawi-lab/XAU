export const ACCEPTED_MARKET_SOURCES = Object.freeze(new Set(['BROKER', 'MARKET_DATA']));

export function isAcceptedMarketSource(value) {
  return ACCEPTED_MARKET_SOURCES.has(String(value ?? '').trim().toUpperCase());
}

export function isFreshMarketSnapshot(value) {
  const source = String(value?.source ?? '').trim().toUpperCase();
  return isAcceptedMarketSource(source) && value?.status === source;
}

