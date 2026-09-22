import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Forex Factory calendar adapter normalizes valid events and ignores malformed rows', async () => {
  const previousFetch = globalThis.fetch;
  const now = new Date('2026-09-22T00:00:00.000Z');
  globalThis.fetch = async () => new Response(JSON.stringify([
    { title: 'CPI m/m', country: 'USD', date: '2026-09-22T12:30:00Z', impact: 'High' },
    { title: 'ECB Speech', country: 'EUR', date: '2026-09-22T13:00:00Z', impact: 'Medium' },
    { title: 'Missing time', country: 'USD', date: 'not-a-time', impact: 'High' },
    { title: 'Unknown impact', country: 'USD', date: '2026-09-22T14:00:00Z', impact: 'Unknown' },
  ]), { status: 200 });
  try {
    const { ForexFactoryNewsCalendarProvider } = await import('../src/providers/forexfactory-news-provider.mjs');
    const payload = await new ForexFactoryNewsCalendarProvider().readCalendar(now);
    assert.equal(payload.source, 'ForexFactory');
    assert.equal(payload.status, 'HEALTHY');
    assert.equal(payload.fetchedAt, now.toISOString());
    assert.equal(payload.events.length, 2);
    assert.deepEqual(payload.events.map((event) => event.currency), ['USD', 'EUR']);
    assert.equal(payload.events[0].impact, 'HIGH');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Forex Factory calendar adapter fails closed on non-JSON provider responses', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad', { status: 200 });
  try {
    const { ForexFactoryNewsCalendarProvider } = await import('../src/providers/forexfactory-news-provider.mjs');
    await assert.rejects(new ForexFactoryNewsCalendarProvider().readCalendar(new Date()), (error) => error.code === 'NEWS_PROVIDER_INVALID_RESPONSE');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
