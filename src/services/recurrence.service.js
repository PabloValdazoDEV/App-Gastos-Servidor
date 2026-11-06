import {
  addCalendarDays,
  addCalendarMonths,
  compareCivilDates,
  endOfMonth,
  startOfMonth,
  toCivilDate,
} from './date.service.js';

const MONTH_STEPS = Object.freeze({
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  YEARLY: 12,
});

export function customWeeksIntervalDays(intervalWeeks) {
  if (!Number.isInteger(intervalWeeks) || intervalWeeks < 2 || intervalWeeks > 520) {
    throw new RangeError('CUSTOM_WEEKS necesita intervalWeeks entero entre 2 y 520.');
  }
  return intervalWeeks * 7;
}

/*
 * Whether a recurring expense still has to be funded in the month of
 * `referenceDate`.
 * - Ended: the end date is before that month, or its last due date inside
 *   the end date has already been settled (nextDueDate moved past endDate).
 * - Not started: only for charges of a month or less (they are covered by the
 *   monthly contribution itself). Longer cycles keep reserving ahead of their
 *   first due date.
 */
export function recurringExpenseIsInEffect(expense, referenceDate) {
  const reference = toCivilDate(referenceDate);
  if (expense.endDate) {
    const end = toCivilDate(expense.endDate);
    if (compareCivilDates(end, startOfMonth(reference)) < 0) return false;
    if (expense.nextDueDate && compareCivilDates(expense.nextDueDate, end) > 0) return false;
  }
  const coveredMonthly =
    expense.frequency === 'MONTHLY' ||
    expense.frequency === 'WEEKLY' ||
    (expense.frequency === 'CUSTOM_MONTHS' && expense.intervalMonths === 1) ||
    (expense.frequency === 'CUSTOM_WEEKS' && expense.intervalWeeks * 7 <= 28);
  if (coveredMonthly && expense.startDate) {
    if (compareCivilDates(expense.startDate, endOfMonth(reference)) > 0) return false;
  }
  return true;
}

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
  intervalWeeks,
) {
  if (frequency === 'ONE_TIME') return null;
  if (frequency === 'WEEKLY') return addCalendarDays(currentDueDate, 7);
  if (frequency === 'CUSTOM_WEEKS') {
    return addCalendarDays(currentDueDate, customWeeksIntervalDays(intervalWeeks));
  }

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
