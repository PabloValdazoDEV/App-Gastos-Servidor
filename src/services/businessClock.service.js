import { AsyncLocalStorage } from 'node:async_hooks';
import { toCivilDate } from './date.service.js';

const businessDateContext = new AsyncLocalStorage();

// Only the development HTTP middleware supplies an override. Authentication,
// audit timestamps and background jobs continue to use the real clock.
export function withBusinessDate(date, operation) {
  return businessDateContext.run(toCivilDate(date), operation);
}

export function businessToday(timezone = 'UTC', now) {
  const override = businessDateContext.getStore();
  if (override && now === undefined) return new Date(override);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now ?? new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return toCivilDate(`${part('year')}-${part('month')}-${part('day')}`);
}
