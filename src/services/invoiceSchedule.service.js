import { addCalendarDays, compareCivilDates, differenceInCalendarDays, toCivilDate, toIsoDate } from './date.service.js';
import { calculateNextDueDate } from './recurrence.service.js';

const ESTIMATE_INVOICES = 3;
const MAX_OCCURRENCES = 60;
const MAX_EARLY_DAYS = 15;

const nextOf = (schedule, date) => calculateNextDueDate(
  date, schedule.frequency, schedule.intervalMonths, schedule.usualDayOfMonth, schedule.intervalWeeks,
);

const byNewest = (left, right) => compareCivilDates(right.invoiceDate, left.invoiceDate);
const average = (items) => Math.round(items.reduce((sum, item) => sum + item.amountCents, 0) / items.length);

/*
 * Estimated amount of the next bill: average of the schedule's last 3 bills;
 * without any, the last 3 bills of the same category and owner; else null.
 */
export function estimateScheduleAmount(schedule, invoices = []) {
  const own = invoices.filter((invoice) => invoice.scheduleId === schedule.id).sort(byNewest).slice(0, ESTIMATE_INVOICES);
  if (own.length) return { amountCents: average(own), basedOn: own.length, source: 'SCHEDULE' };
  const similar = invoices
    .filter((invoice) => invoice.categoryId === schedule.categoryId
      && invoice.scope === schedule.scope
      && (invoice.personalPersonId ?? null) === (schedule.personalPersonId ?? null))
    .sort(byNewest).slice(0, ESTIMATE_INVOICES);
  if (similar.length) return { amountCents: average(similar), basedOn: similar.length, source: 'CATEGORY' };
  return { amountCents: null, basedOn: 0, source: null };
}

// Expected bill dates inside [rangeStart, rangeEnd], respecting the end date.
export function scheduleOccurrences(schedule, rangeStart, rangeEnd) {
  if (!schedule.isActive) return [];
  const start = toCivilDate(rangeStart);
  const end = toCivilDate(rangeEnd);
  const last = schedule.endDate ? toCivilDate(schedule.endDate) : null;
  const dates = [];
  let current = toCivilDate(schedule.nextExpectedDate);
  for (let guard = 0; guard < 600 && dates.length < MAX_OCCURRENCES; guard += 1) {
    if (compareCivilDates(current, end) > 0 || (last && compareCivilDates(current, last) > 0)) break;
    if (compareCivilDates(current, start) >= 0) dates.push(toIsoDate(current));
    const next = nextOf(schedule, current);
    if (!next) break;
    current = next;
  }
  return dates;
}

/*
 * After registering a real bill dated `invoiceDate`, move the expected date
 * forward. A bill may arrive a few days early (up to 15, or half a short
 * cycle) or late; an old bill registered afterwards does not move it.
 */
export function advanceScheduleAfterInvoice(schedule, invoiceDate) {
  const billDate = toCivilDate(invoiceDate);
  let expected = toCivilDate(schedule.nextExpectedDate);
  for (let guard = 0; guard < 600; guard += 1) {
    const next = nextOf(schedule, expected);
    if (!next) return expected;
    const earlyDays = Math.min(MAX_EARLY_DAYS, Math.floor(differenceInCalendarDays(next, expected) / 2));
    if (compareCivilDates(expected, addCalendarDays(billDate, earlyDays)) > 0) return expected;
    expected = next;
  }
  return expected;
}
