import { buildCalendar } from './calendar.service.js';

const typeFor = (source) => ({
  RECURRING_EXPENSE: 'RECURRING', INVOICE: 'INVOICE',
  VARIABLE_EXPENSE: 'VARIABLE', VARIABLE_SUMMARY: 'VARIABLE',
  ONE_TIME_EXPENSE: 'ONE_TIME', PURCHASE_UPFRONT: 'PURCHASE',
  PURCHASE_DOWN_PAYMENT: 'PURCHASE', PURCHASE_INSTALLMENT: 'PURCHASE',
})[source];

const categoryKey = (item) => `${item.category?.id ?? ''}:${item.scope}:${item.personalPersonId ?? ''}`;
const sum = (items) => items.reduce((total, item) => total + item.amountCents, 0);

function summarize(events, budgetLines, balanceCents, balanceSource) {
  const lines = events.filter((event) => event.status !== 'SKIPPED').map((event) => ({
    id: `${event.sourceType}:${event.id ?? event.expenseId}:${event.dueDate}`,
    name: event.name,
    type: typeFor(event.sourceType),
    category: event.category,
    scope: event.scope,
    personalPersonId: event.personalPersonId,
    sourceType: event.sourceType,
    date: event.dueDate,
    datePrecision: event.datePrecision ?? 'DAY',
    status: event.status === 'PAID' ? 'PAID' : 'UNCONFIRMED',
    amountCents: event.amountCents,
  }));

  // Only variable spending and bills need a history-based allowance here.
  // Annual recurring savings, contribution adjustments and known-expense
  // margins are NOT cash payments due this month.
  budgetLines.filter((line) => ['VARIABLE', 'INVOICE'].includes(line.type)).forEach((forecast) => {
    const registered = lines.filter((line) => line.type === forecast.type && categoryKey(line) === categoryKey(forecast));
    // A supplied bill or a monthly summary replaces its estimate, not adds to it.
    if (forecast.type === 'INVOICE' && registered.length) return;
    if (registered.some((line) => line.sourceType === 'VARIABLE_SUMMARY')) return;
    const recordedCents = sum(registered);
    const amountCents = Math.max(0, forecast.amountCents - recordedCents);
    if (!amountCents) return;
    lines.push({
      id: `estimate:${forecast.type}:${forecast.id}`,
      name: forecast.name,
      type: forecast.type,
      category: forecast.category,
      status: 'ESTIMATED',
      amountCents,
      basisTotalCents: forecast.amountCents,
      recordedCents,
      allowanceCents: Math.max(0, forecast.amountCents - forecast.baseCents),
    });
  });

  const paidCents = sum(lines.filter((line) => line.status === 'PAID'));
  const unconfirmedCents = sum(lines.filter((line) => line.status === 'UNCONFIRMED'));
  const estimatedCents = sum(lines.filter((line) => line.status === 'ESTIMATED'));
  const remainingCents = unconfirmedCents + estimatedCents;
  return {
    balanceCents, balanceSource,
    expectedCents: paidCents + remainingCents,
    paidCents, unconfirmedCents, estimatedCents, remainingCents,
    // The balance is manually recorded NOW, not the balance at month start.
    // Confirmed payments must never be subtracted from it a second time.
    projectedBalanceCents: balanceCents === null ? null : balanceCents - remainingCents,
    lines,
  };
}

export function calculateMonthlyOverview({
  calculationDate, recurringExpenses = [], payments = [], purchaseSources = [],
  invoices = [], variableMonths = [], oneTimeExpenses = [], budgetLines = [],
  viewerPersonId = null, includeViewerPurchaseHistory = false,
  commonBalanceCents, commonBalanceSource, personalBalanceCents = null,
}) {
  const expenses = new Map(recurringExpenses.map((expense) => [expense.id, expense]));
  // Paid/omitted occurrences survive archiving. Do not generate fresh scheduled
  // payments for a parent which wasn't returned by the active-expense query.
  payments.forEach((payment) => {
    if (!expenses.has(payment.recurringExpenseId)) {
      expenses.set(payment.recurringExpenseId, { ...payment.recurringExpense, isActive: false });
    }
  });
  const calendar = buildCalendar({
    recurringExpenses: [...expenses.values()], payments, purchaseSources,
    invoices, variableMonths, oneTimeExpenses,
    today: calculationDate, anchorDate: calculationDate, view: 'MONTH',
  });
  const own = (item) => item.scope === 'PERSONAL' && (
    (viewerPersonId && item.personalPersonId === viewerPersonId)
    // Purchase allocations are already filtered by authenticated user upstream,
    // including immutable historical shares after household-person unlinking.
    || (includeViewerPurchaseHistory && item.sourceType?.startsWith('PURCHASE_'))
  );
  return {
    rangeStart: calendar.rangeStart,
    rangeEnd: calendar.rangeEnd,
    common: summarize(calendar.events.filter((item) => item.scope === 'HOUSEHOLD'),
      budgetLines.filter((item) => item.scope === 'HOUSEHOLD'), commonBalanceCents, commonBalanceSource),
    personal: viewerPersonId || includeViewerPurchaseHistory
      ? summarize(calendar.events.filter(own), budgetLines.filter(own), personalBalanceCents,
        personalBalanceCents === null ? null : 'ACCOUNTS')
      : null,
  };
}
