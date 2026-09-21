// Deterministic synthetic candles for unit tests only; never seed them into the app database.
export function syntheticCandles({ count = 140, startPrice = 2000, step = 0.18, timeframeMs = 15 * 60_000, startAt = '2026-01-05T00:00:00.000Z' } = {}) {
  const origin = Date.parse(startAt);
  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin(index / 2.5) * 0.08;
    const open = startPrice + index * step + wave;
    const close = open + step + Math.cos(index / 3.1) * 0.04;
    return {
      open,
      high: Math.max(open, close) + 0.25,
      low: Math.min(open, close) - 0.25,
      close,
      tickVolume: 100 + (index % 9) * 7,
      closedAt: new Date(origin + (index + 1) * timeframeMs).toISOString(),
      source: 'SYNTHETIC',
    };
  });
}
