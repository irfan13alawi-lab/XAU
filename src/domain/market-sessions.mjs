function parts(date, timeZone) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(values.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
}

export function activeSessions(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('A valid date is required.');
  const newYork = parts(now, 'America/New_York');
  const newYorkLocalMinute = Number(newYork.hour) * 60 + Number(newYork.minute);
  const weekendClosed = newYork.weekday === 'Sat'
    || (newYork.weekday === 'Sun' && newYorkLocalMinute < 17 * 60)
    || (newYork.weekday === 'Fri' && newYorkLocalMinute >= 17 * 60);
  const windows = [
    { name: 'ASIA', timeZone: 'Asia/Tokyo', open: 9 * 60, close: 18 * 60 },
    { name: 'LONDON', timeZone: 'Europe/London', open: 8 * 60, close: 17 * 60 },
    { name: 'NEW_YORK', timeZone: 'America/New_York', open: 8 * 60, close: 17 * 60 },
  ];
  const active = weekendClosed ? [] : windows.filter(({ timeZone, open, close }) => {
    const local = parts(now, timeZone);
    const minute = Number(local.hour) * 60 + Number(local.minute);
    return Number.isFinite(minute) && minute >= open && minute < close;
  }).map(({ name }) => name);
  return {
    active,
    marketScheduleStatus: weekendClosed ? 'WEEKEND_CLOSED' : 'SCHEDULED_OPEN · HOLIDAYS UNKNOWN',
    evaluatedAt: now.toISOString(),
    timezoneRules: 'Indicative session windows use IANA time zones; DST is handled by the runtime timezone database. Broker holidays/hours are not verified.',
  };
}
