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
            !['WEEKLY', 'CUSTOM_WEEKS', 'ONE_TIME'].includes(expense.frequency)
              ? toCivilDate(expense.startDate).getUTCDate()
              : undefined),
          expense.intervalWeeks,
        )
      : null;
  }

  return occurrences;
}

export function calendarRange({ view = '30_DAYS', anchorDate }) {
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

  return { rangeStart, rangeEnd };
}

export function buildCalendar({
  recurringExpenses,
  payments = [],
  purchaseSources = [],
  invoices = [],
  variableMonths = [],
  oneTimeExpenses = [],
  today,
  view = '30_DAYS',
  anchorDate = today,
}) {
  const { rangeStart, rangeEnd } = calendarRange({ view, anchorDate });
  const scheduledEvents = recurringExpenses
    .filter((expense) => expense.isActive !== false && !expense.archivedAt)
    .flatMap((expense) =>
      occurrencesInsideRange(expense, rangeStart, rangeEnd).map((occurrenceDate) => ({
        sourceType: 'RECURRING_EXPENSE',
        expenseId: expense.id,
        name: expense.name,
        dueDate: toIsoDate(occurrenceDate),
        amountCents: expense.amountCents,
        expectedAmountCents: expense.amountCents,
        actualAmountCents: null,
        paymentDate: null,
        paymentId: null,
        notes: null,
        canRegisterPayment:
          compareCivilDates(occurrenceDate, expense.nextDueDate) === 0,
        canEditPayment: false,
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
      sourceType: 'RECURRING_EXPENSE',
      expenseId: expense.id,
      paymentId: payment.id ?? null,
      name: expense.name,
      dueDate: toIsoDate(dueDate),
      amountCents: amountForPayment(payment, expense),
      expectedAmountCents: payment.expectedAmountCents ?? expense.amountCents,
      actualAmountCents: payment.actualAmountCents ?? null,
      paymentDate: payment.paymentDate ? toIsoDate(payment.paymentDate) : null,
      notes: payment.notes ?? null,
      canRegisterPayment: false,
      canEditPayment: Boolean(payment.id),
      scope: expense.scope,
      personalPersonId: expense.personalPersonId ?? null,
      personalPerson: expense.personalPerson ?? null,
      category: expense.category ?? null,
      status: payment.status,
      daysFromToday: differenceInCalendarDays(dueDate, today),
    });
  });

  const purchaseEvents = purchaseSources.filter((source) => source.status !== 'CANCELLED'
    && compareCivilDates(source.dueDate, rangeStart) >= 0 && compareCivilDates(source.dueDate, rangeEnd) <= 0)
    .map((source) => ({
      ...source,
      amountCents: source.status === 'PAID' ? source.actualAmountCents : source.expectedAmountCents,
      paymentDate: source.paidAt, paymentId: source.status === 'PAID' ? source.installmentId : null,
      category: null, personalPerson: null, notes: null,
      status: source.status === 'PAID' ? 'PAID' : deriveScheduledStatus(today, source.dueDate),
      daysFromToday: differenceInCalendarDays(source.dueDate, today),
    }));
  const isInRange = (date) => compareCivilDates(date, rangeStart) >= 0
    && compareCivilDates(date, rangeEnd) <= 0;
  // These expense records have a payment confirmation date, but no separate
  // actual amount; confirmation must not alter their planned date or amount.
  const recordedEvent = (record, sourceType, date, name, amountCents) => ({
    id: record.id,
    sourceType,
    name,
    dueDate: toIsoDate(date),
    datePrecision: 'DAY',
    amountCents,
    expectedAmountCents: amountCents,
    actualAmountCents: record.paidAt ? amountCents : null,
    paymentId: null,
    paymentDate: record.paidAt ? toIsoDate(record.paidAt) : null,
    canRegisterPayment: !record.paidAt,
    canEditPayment: false,
    scope: record.scope,
    personalPersonId: record.personalPersonId ?? null,
    personalPerson: record.personalPerson ?? null,
    category: record.category ?? null,
    status: record.paidAt ? 'PAID' : 'RECORDED',
    daysFromToday: differenceInCalendarDays(date, today),
  });
  const invoiceEvents = invoices.filter((invoice) => isInRange(invoice.chargeDate ?? invoice.invoiceDate))
    .map((invoice) => ({
      ...recordedEvent(invoice, 'INVOICE', invoice.chargeDate ?? invoice.invoiceDate,
        invoice.category?.name ?? 'Factura', invoice.amountCents),
      dateBasis: invoice.chargeDate ? 'CHARGE_DATE' : 'INVOICE_DATE',
    }));
  const oneTimeEvents = oneTimeExpenses.filter((expense) => isInRange(expense.expenseDate))
    .map((expense) => ({
      ...recordedEvent(expense, 'ONE_TIME_EXPENSE', expense.expenseDate, expense.name, expense.amountCents),
      status: expense.paidAt ? 'PAID' : 'UNCONFIRMED',
      expectedAmountCents: expense.amountCents,
      actualAmountCents: expense.paidAt ? expense.amountCents : null,
    }));
  const variableEvents = variableMonths.flatMap((month) => {
    if (month.entryMode === 'SUMMARY') {
      const periodStart = new Date(Date.UTC(month.year, month.month - 1, 1));
      const periodEnd = endOfMonth(periodStart);
      if (compareCivilDates(periodStart, rangeEnd) > 0 || compareCivilDates(periodEnd, rangeStart) < 0) return [];
      return [{
        ...recordedEvent(month, 'VARIABLE_SUMMARY', periodStart,
          month.category?.name ?? 'Gasto variable', month.summaryAmountCents),
        variableMonthId: month.id,
        datePrecision: 'MONTH',
        periodStart: toIsoDate(periodStart),
        periodEnd: toIsoDate(periodEnd),
        daysFromToday: null,
      }];
    }
    return (month.entries ?? []).filter((entry) => isInRange(entry.spentOn)).map((entry) => ({
      ...recordedEvent({ ...month, id: entry.id, paidAt: entry.paidAt }, 'VARIABLE_EXPENSE', entry.spentOn,
        entry.merchant || month.category?.name || 'Gasto variable', entry.amountCents),
      variableMonthId: month.id,
    }));
  });
  const events = [...eventsByOccurrence.values(), ...purchaseEvents, ...invoiceEvents, ...oneTimeEvents, ...variableEvents].sort((left, right) => {
    const dateComparison = left.dueDate.localeCompare(right.dueDate);
    if (dateComparison !== 0) return dateComparison;
    return (left.expenseId ?? left.id).localeCompare(right.expenseId ?? right.id);
  });

  return {
    view,
    rangeStart: toIsoDate(rangeStart),
    rangeEnd: toIsoDate(rangeEnd),
    events,
  };
}
