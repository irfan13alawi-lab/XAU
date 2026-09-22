const SOURCE = 'ForexFactory';
const CALENDAR_URLS = Object.freeze([
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json',
]);
const MAX_EVENTS = 500;

function errorWithCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function scheduledAt(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeImpact(value) {
  const impact = String(value ?? '').trim().toUpperCase();
  return ['HIGH', 'MEDIUM', 'LOW', 'HOLIDAY'].includes(impact) ? impact : null;
}

async function readCalendarJson(signal) {
  let lastError = null;
  for (const url of CALENDAR_URLS) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        lastError = errorWithCode(response.status === 429 ? 'NEWS_PROVIDER_RATE_LIMITED' : 'NEWS_PROVIDER_HTTP_ERROR');
        continue;
      }
      let body;
      try { body = await response.json(); } catch { lastError = errorWithCode('NEWS_PROVIDER_INVALID_RESPONSE'); continue; }
      if (Array.isArray(body)) return body;
      lastError = errorWithCode('NEWS_PROVIDER_INVALID_RESPONSE');
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = errorWithCode('NEWS_PROVIDER_NETWORK_ERROR');
    }
  }
  throw lastError ?? errorWithCode('NEWS_PROVIDER_NETWORK_ERROR');
}

export class ForexFactoryNewsCalendarProvider {
  async readCalendar(now = new Date(), { signal } = {}) {
    const rows = await readCalendarJson(signal);
    const events = rows.slice(0, MAX_EVENTS).map((row) => {
      const currency = String(row?.country ?? '').trim().toUpperCase();
      const title = String(row?.title ?? '').trim();
      const impact = normalizeImpact(row?.impact);
      const eventTime = scheduledAt(row?.date);
      if (!/^[A-Z]{3}$/.test(currency) || !title || !impact || !eventTime) return null;
      return {
        title,
        currency,
        impact,
        scheduledAt: eventTime,
        category: title.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64) || 'CALENDAR_EVENT',
        eventKey: `${currency}|${title}|${eventTime}`,
      };
    }).filter(Boolean);
    return {
      source: SOURCE,
      status: 'HEALTHY',
      fetchedAt: now.toISOString(),
      events,
      reason: null,
    };
  }
}
