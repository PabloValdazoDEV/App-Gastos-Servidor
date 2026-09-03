import {
  addCalendarDays,
  compareCivilDates,
  differenceInCalendarDays,
  endOfMonth,
  startOfMonth,
  toCivilDate,
  toIsoDate,
} from './date.service.js';
import { calculateNextDueDate } from './recurrence.service.js';

function deriveScheduledStatus(today, occurrenceDate) {
  const comparison = compareCivilDates(occurrenceDate, today);
  if (comparison < 0) return 'OVERDUE';
  if (comparison === 0) return 'DUE';
  return 'UPCOMING';
}

const eventKey = (expenseId, dueDate) => `${expenseId}:${toIsoDate(dueDate)}`;

function amountForPayment(payment, expense) {
  if (payment.status === 'PAID' && Number.isSafeInteger(payment.actualAmountCents)) {
    return payment.actualAmountCents;
  }
  if (Number.isSafeInteger(payment.expectedAmountCents)) {
    return payment.expectedAmountCents;
  }
  return expense.amountCents;
}

function occurrencesInsideRange(expense, rangeStart, rangeEnd) {
  let current = toCivilDate(expense.nextDueDate);
  const occurrences = [];

  for (let index = 0; index < 600 && current; index += 1) {
    if (expense.endDate && compareCivilDates(current, expense.endDate) > 0) break;
    if (compareCivilDates(current, rangeEnd) > 0) break;
    if (compareCivilDates(current, rangeStart) >= 0) occurrences.push(current);
    current = expense.frequency
      ? calculateNextDueDate(
          current,
          expense.frequency,
          expense.intervalMonths,
          expense.usualDayOfMonth ??
            (expense.startDate &&
            !['WEEKLY', 'ONE_TIME'].includes(expense.frequency)
              ? toCivilDate(expense.startDate).getUTCDate()
              : undefined),
        )
      : null;
  }

  return occurrences;
}

export function buildCalendar({
  recurringExpenses,
  payments = [],
  today,
  view = '30_DAYS',
  anchorDate = today,
}) {
  const anchor = toCivilDate(anchorDate);
  let rangeStart;
  let rangeEnd;

  if (view === 'MONTH') {
    rangeStart = startOfMonth(anchor);
    rangeEnd = endOfMonth(anchor);
  } else if (view === '90_DAYS') {
    rangeStart = anchor;
    rangeEnd = addCalendarDays(anchor, 89);
  } else if (view === 'YEAR') {
    rangeStart = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
    rangeEnd = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
  } else {
    rangeStart = anchor;
    rangeEnd = addCalendarDays(anchor, 29);
  }

  const scheduledEvents = recurringExpenses
    .filter((expense) => expense.isActive !== false && !expense.archivedAt)
    .flatMap((expense) =>
      occurrencesInsideRange(expense, rangeStart, rangeEnd).map((occurrenceDate) => ({
        expenseId: expense.id,
        name: expense.name,
        dueDate: toIsoDate(occurrenceDate),
        amountCents: expense.amountCents,
        scope: expense.scope,
        personalPersonId: expense.personalPersonId ?? null,
        personalPerson: expense.personalPerson ?? null,
        category: expense.category ?? null,
        status: deriveScheduledStatus(today, occurrenceDate),
        daysFromToday: differenceInCalendarDays(occurrenceDate, today),
      })),
    );
  const expensesById = new Map(
    recurringExpenses.map((expense) => [expense.id, expense]),
  );
  const eventsByOccurrence = new Map(
    scheduledEvents.map((event) => [
      eventKey(event.expenseId, event.dueDate),
      event,
    ]),
  );

  payments.forEach((payment) => {
    const expense = expensesById.get(payment.recurringExpenseId);
    if (!expense || !['PAID', 'SKIPPED'].includes(payment.status)) return;

    const dueDate = toCivilDate(payment.dueDate);
    if (
      compareCivilDates(dueDate, rangeStart) < 0 ||
      compareCivilDates(dueDate, rangeEnd) > 0
    ) {
      return;
    }

    eventsByOccurrence.set(eventKey(expense.id, dueDate), {
      expenseId: expense.id,
      paymentId: payment.id ?? null,
      name: expense.name,
      dueDate: toIsoDate(dueDate),
      amountCents: amountForPayment(payment, expense),
      expectedAmountCents: payment.expectedAmountCents ?? expense.amountCents,
      actualAmountCents: payment.actualAmountCents ?? null,
      paymentDate: payment.paymentDate ? toIsoDate(payment.paymentDate) : null,
      scope: expense.scope,
      personalPersonId: expense.personalPersonId ?? null,
      personalPerson: expense.personalPerson ?? null,
      category: expense.category ?? null,
      status: payment.status,
      daysFromToday: differenceInCalendarDays(dueDate, today),
    });
  });

  const events = [...eventsByOccurrence.values()].sort((left, right) => {
    const dateComparison = left.dueDate.localeCompare(right.dueDate);
    if (dateComparison !== 0) return dateComparison;
    return left.expenseId.localeCompare(right.expenseId);
  });

  return {
    view,
    rangeStart: toIsoDate(rangeStart),
    rangeEnd: toIsoDate(rangeEnd),
    events,
  };
}
