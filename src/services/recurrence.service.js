import {
  addCalendarDays,
  addCalendarMonths,
  toCivilDate,
} from './date.service.js';

const MONTH_STEPS = Object.freeze({
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  YEARLY: 12,
});

function restoreUsualDay(date, usualDayOfMonth) {
  if (!Number.isInteger(usualDayOfMonth)) return date;
  if (usualDayOfMonth < 1 || usualDayOfMonth > 31) {
    throw new RangeError('usualDayOfMonth debe estar entre 1 y 31.');
  }
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(usualDayOfMonth, lastDay));
  return date;
}

export function calculateNextDueDate(
  currentDueDate,
  frequency,
  intervalMonths,
  usualDayOfMonth,
) {
  if (frequency === 'ONE_TIME') return null;
  if (frequency === 'WEEKLY') return addCalendarDays(currentDueDate, 7);

  const months =
    frequency === 'CUSTOM_MONTHS' ? intervalMonths : MONTH_STEPS[frequency];

  if (!Number.isInteger(months) || months < 1) {
    throw new RangeError(`Periodicidad no soportada: ${frequency}`);
  }

  return restoreUsualDay(
    addCalendarMonths(toCivilDate(currentDueDate), months),
    usualDayOfMonth,
  );
}
