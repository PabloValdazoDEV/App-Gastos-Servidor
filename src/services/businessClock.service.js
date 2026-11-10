import { AsyncLocalStorage } from 'node:async_hooks';
import { toCivilDate } from './date.service.js';

const businessDateContext = new AsyncLocalStorage();

// Only the development HTTP middleware supplies an override. Authentication,
// audit timestamps and background jobs continue to use the real clock.
export function withBusinessDate(date, operation) {
  return businessDateContext.run(toCivilDate(date), operation);
}

// "Today" without a household timezone used to be the UTC date: from midnight
// to 01:00/02:00 in Spain the app still showed the previous day (and on the
// 1st, the previous month). The server sets this from DEFAULT_TIMEZONE.
let defaultTimezone = 'UTC';

export function setDefaultBusinessTimezone(timezone) {
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  defaultTimezone = timezone;
}

export function businessToday(timezone = defaultTimezone, now) {
  const override = businessDateContext.getStore();
  if (override && now === undefined) return new Date(override);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now ?? new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return toCivilDate(`${part('year')}-${part('month')}-${part('day')}`);
}
