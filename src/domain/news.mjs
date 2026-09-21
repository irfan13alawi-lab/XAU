const HIGH_IMPACT_USD_EVENTS = new Set([
  'FOMC', 'CPI', 'NFP', 'PPI', 'GDP', 'FED_SPEECH', 'UNEMPLOYMENT',
]);

export function evaluateNewsBlackout({
  events,
  fetchedAt,
  sourceStatus,
  now = new Date(),
  beforeMinutes = 30,
  afterMinutes = 30,
  maxAgeMinutes = 30,
}) {
  const reasons = [];
  if (sourceStatus !== 'HEALTHY') reasons.push('NEWS_SOURCE_UNAVAILABLE');
  const fetched = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(fetched) || now.getTime() - fetched > maxAgeMinutes * 60_000 || fetched > now.getTime() + 60_000) {
    reasons.push('NEWS_DATA_STALE_OR_AMBIGUOUS');
  }
  if (!Array.isArray(events)) reasons.push('NEWS_EVENTS_INVALID');
  if (reasons.length) return { allowed: false, inBlackout: true, reasons: [...new Set(reasons)], nextEvent: null };

  const relevant = [];
  for (const event of events) {
    const currency = String(event.currency ?? '').toUpperCase();
    const category = String(event.category ?? event.eventType ?? '').toUpperCase().replaceAll(' ', '_');
    const highImpact = String(event.impact ?? '').toUpperCase() === 'HIGH' || HIGH_IMPACT_USD_EVENTS.has(category);
    if (currency !== 'USD' || !highImpact) continue;
    const scheduled = Date.parse(event.scheduledAt ?? event.scheduled_at ?? '');
    if (!Number.isFinite(scheduled)) {
      reasons.push('NEWS_EVENT_TIME_AMBIGUOUS');
      continue;
    }
    relevant.push({ event, scheduled });
  }
  if (reasons.length) return { allowed: false, inBlackout: true, reasons: [...new Set(reasons)], nextEvent: null };

  const current = now.getTime();
  const active = relevant
    .filter(({ scheduled }) => current >= scheduled - beforeMinutes * 60_000 && current <= scheduled + afterMinutes * 60_000)
    .sort((a, b) => a.scheduled - b.scheduled)[0];
  const next = relevant.filter(({ scheduled }) => scheduled > current).sort((a, b) => a.scheduled - b.scheduled)[0];
  return {
    allowed: !active,
    inBlackout: Boolean(active),
    reasons: active ? ['NEWS_BLACKOUT'] : [],
    nextEvent: (active ?? next)?.event ?? null,
    window: active ? {
      startsAt: new Date(active.scheduled - beforeMinutes * 60_000).toISOString(),
      endsAt: new Date(active.scheduled + afterMinutes * 60_000).toISOString(),
    } : null,
  };
}
