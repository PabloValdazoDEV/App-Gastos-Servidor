import {
  addCalendarMonths,
  inclusivePeriodDays,
  monthKey,
  startOfMonth,
  toCivilDate,
} from './date.service.js';
import {
  applyMarginCents,
  assertSafeInteger,
  roundDivide,
  splitAmount,
} from './money.service.js';

const MONTH_DIVISORS = Object.freeze({
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  YEARLY: 12,
});

export function monthlyEquivalentCents({ amountCents, frequency, intervalMonths }) {
  assertSafeInteger(amountCents, 'amountCents');
  if (amountCents < 0) throw new RangeError('amountCents no puede ser negativo.');

  if (frequency === 'ONE_TIME') return 0;
  if (frequency === 'WEEKLY') {
    return roundDivide(BigInt(amountCents) * 52n, 12n);
  }

  if (frequency === 'CUSTOM_MONTHS') {
    if (!Number.isInteger(intervalMonths) || intervalMonths < 1) {
      throw new RangeError('CUSTOM_MONTHS necesita intervalMonths >= 1.');
    }
    return roundDivide(amountCents, intervalMonths);
  }

  const divisor = MONTH_DIVISORS[frequency];
  if (!divisor) throw new RangeError(`Periodicidad no soportada: ${frequency}`);
  return roundDivide(amountCents, divisor);
}

export function resolveMarginBps({
  expenseMarginBps,
  categoryMarginBps,
  householdMarginBps,
}) {
  const margin = expenseMarginBps ?? categoryMarginBps ?? householdMarginBps ?? 0;
  assertSafeInteger(margin, 'marginBps');
  if (margin < 0 || margin > 10_000) throw new RangeError('Margen fuera de rango.');
  return margin;
}

export function invoiceMonthlyEquivalentCents(invoice) {
  const periodDays = inclusivePeriodDays(invoice.periodStart, invoice.periodEnd);
  return roundDivide(BigInt(invoice.amountCents) * 3_044n, BigInt(periodDays) * 100n);
}

function weightedInvoiceAverage(invoices) {
  if (invoices.length === 0) return null;
  const totals = invoices.reduce(
    (result, invoice) => ({
      amountCents: result.amountCents + BigInt(invoice.amountCents),
      days: result.days + BigInt(inclusivePeriodDays(invoice.periodStart, invoice.periodEnd)),
    }),
    { amountCents: 0n, days: 0n },
  );
  return roundDivide(totals.amountCents * 3_044n, totals.days * 100n);
}

function invoicesInsideWindow(invoices, latestDate, windowMonths) {
  const threshold = startOfMonth(addCalendarMonths(latestDate, -(windowMonths - 1)));
  return invoices.filter((invoice) => toCivilDate(invoice.periodEnd) >= threshold);
}

export function calculateInvoiceStatistics(
  invoices,
  { householdMarginBps = 0, categoryMarginBps = null } = {},
) {
  const sorted = [...invoices].sort(
    (left, right) => toCivilDate(left.periodEnd) - toCivilDate(right.periodEnd),
  );

  if (sorted.length === 0) {
    return {
      invoiceCount: 0,
      latestInvoice: null,
      historicalAverageCents: null,
      averages: { months3: null, months6: null, months12: null },
      recommendedCents: null,
      effectiveMarginBps: resolveMarginBps({
        categoryMarginBps,
        householdMarginBps,
      }),
    };
  }

  const latestInvoice = sorted.at(-1);
  const latestDate = latestInvoice.periodEnd;
  const effectiveMarginBps = resolveMarginBps({
    categoryMarginBps,
    householdMarginBps,
  });
  const historicalAverageCents = weightedInvoiceAverage(sorted);

  return {
    invoiceCount: sorted.length,
    latestInvoice,
    historicalAverageCents,
    averages: {
      months3: weightedInvoiceAverage(invoicesInsideWindow(sorted, latestDate, 3)),
      months6: weightedInvoiceAverage(invoicesInsideWindow(sorted, latestDate, 6)),
      months12: weightedInvoiceAverage(invoicesInsideWindow(sorted, latestDate, 12)),
    },
    recommendedCents: applyMarginCents(historicalAverageCents, effectiveMarginBps),
    effectiveMarginBps,
  };
}

export function variableMonthTotalCents(variableMonth) {
  if (variableMonth.entryMode === 'SUMMARY') {
    if (!Number.isSafeInteger(variableMonth.summaryAmountCents)) {
      throw new TypeError('El modo SUMMARY necesita summaryAmountCents.');
    }
    return variableMonth.summaryAmountCents;
  }

  if (variableMonth.entryMode !== 'DETAIL') {
    throw new RangeError('Modo de gasto variable no soportado.');
  }

  return (variableMonth.entries ?? []).reduce((sum, entry) => {
    assertSafeInteger(entry.amountCents, 'entry.amountCents');
    return sum + entry.amountCents;
  }, 0);
}

function calendarMonthIndex(year, month) {
  return year * 12 + month - 1;
}

export function calculateVariableStatistics(
  variableMonths,
  {
    householdMarginBps = 0,
    categoryMarginBps = null,
    calculationDate = new Date(),
  } = {},
) {
  const calculationDateValue = toCivilDate(calculationDate);
  const calculationMonthIndex = calendarMonthIndex(
    calculationDateValue.getUTCFullYear(),
    calculationDateValue.getUTCMonth() + 1,
  );
  const completed = variableMonths
    .filter((item) => calendarMonthIndex(item.year, item.month) < calculationMonthIndex)
    .map((item) => ({ ...item, totalCents: variableMonthTotalCents(item) }))
    .sort((left, right) =>
      calendarMonthIndex(left.year, left.month) - calendarMonthIndex(right.year, right.month),
    );
  const effectiveMarginBps = resolveMarginBps({
    categoryMarginBps,
    householdMarginBps,
  });

  if (completed.length === 0) {
    return {
      completedMonths: 0,
      latestMonth: null,
      averages: { months3: null, months6: null, months12: null },
      availableMonths: { months3: 0, months6: 0, months12: 0 },
      recommendedCents: null,
      effectiveMarginBps,
    };
  }

  const latest = completed.at(-1);
  const latestIndex = calendarMonthIndex(latest.year, latest.month);
  const calculateWindow = (windowMonths) => {
    const selected = completed.filter(
      (item) => latestIndex - calendarMonthIndex(item.year, item.month) < windowMonths,
    );
    const total = selected.reduce((sum, item) => sum + item.totalCents, 0);
    return {
      averageCents: selected.length ? roundDivide(total, selected.length) : null,
      availableMonths: selected.length,
    };
  };
  const months3 = calculateWindow(3);
  const months6 = calculateWindow(6);
  const months12 = calculateWindow(12);
  const base = months3.averageCents ?? months6.averageCents ?? months12.averageCents;

  return {
    completedMonths: completed.length,
    latestMonth: `${latest.year}-${String(latest.month).padStart(2, '0')}`,
    averages: {
      months3: months3.averageCents,
      months6: months6.averageCents,
      months12: months12.averageCents,
    },
    availableMonths: {
      months3: months3.availableMonths,
      months6: months6.availableMonths,
      months12: months12.availableMonths,
    },
    recommendedCents: base === null ? null : applyMarginCents(base, effectiveMarginBps),
    effectiveMarginBps,
  };
}

function categoryMargin(item) {
  return item.category?.safetyMarginBps ?? item.categoryMarginBps ?? null;
}

function sumByPerson(items) {
  return items.reduce((totals, item) => {
    if (!item.personalPersonId) return totals;
    totals.set(item.personalPersonId, (totals.get(item.personalPersonId) ?? 0) + item.amountCents);
    return totals;
  }, new Map());
}

export function calculateMonthlyStandardBudget({
  calculationDate = new Date(),
  householdMarginBps = 0,
  people,
  recurringExpenses = [],
  invoiceGroups = [],
  variableGroups = [],
  oneTimeExpenses = [],
}) {
  const calculationDateValue = toCivilDate(calculationDate);
  const calculationYear = calculationDateValue.getUTCFullYear();
  const calculationMonth = calculationDateValue.getUTCMonth() + 1;
  const recurringLines = recurringExpenses
    .filter((expense) => expense.isActive !== false && !expense.archivedAt)
    .map((expense) => {
      const baseCents = monthlyEquivalentCents(expense);
      const effectiveMarginBps = resolveMarginBps({
        expenseMarginBps: expense.safetyMarginOverrideBps,
        categoryMarginBps: categoryMargin(expense),
        householdMarginBps,
      });
      return {
        id: expense.id,
        name: expense.name,
        category: expense.category,
      type: 'RECURRING',
        scope: expense.scope,
        personalPersonId: expense.personalPersonId,
        baseCents,
        effectiveMarginBps,
        amountCents: applyMarginCents(baseCents, effectiveMarginBps),
      };
    });

  const invoiceLines = invoiceGroups.flatMap((group) => {
    const statistics = calculateInvoiceStatistics(group.invoices ?? [], {
      householdMarginBps,
      categoryMarginBps: categoryMargin(group),
    });
    if (statistics.recommendedCents === null) return [];
    return [{
      id: group.categoryId,
      name: group.category?.name ?? 'Factura sin categoría',
      category: group.category,
      type: 'INVOICE',
      scope: group.scope ?? 'HOUSEHOLD',
      personalPersonId: group.personalPersonId ?? null,
      baseCents: statistics.historicalAverageCents,
      effectiveMarginBps: statistics.effectiveMarginBps,
      amountCents: statistics.recommendedCents,
      statistics,
    }];
  });

  const variableLines = variableGroups.flatMap((group) => {
    const statistics = calculateVariableStatistics(group.months ?? [], {
      calculationDate,
      householdMarginBps,
      categoryMarginBps: categoryMargin(group),
    });
    if (statistics.recommendedCents === null) return [];
    return [{
      id: `${group.categoryId}:${group.ownerKey ?? 'HOUSEHOLD'}`,
      name: group.category?.name ?? 'Gasto variable sin categoría',
      category: group.category,
      type: 'VARIABLE',
      scope: group.scope ?? 'HOUSEHOLD',
      personalPersonId: group.personalPersonId ?? null,
      baseCents: statistics.averages.months3,
      effectiveMarginBps: statistics.effectiveMarginBps,
      amountCents: statistics.recommendedCents,
      statistics,
    }];
  });

  const oneTimeLines = oneTimeExpenses
    .filter((expense) => {
      if (expense.isActive === false || expense.archivedAt) return false;
      const expenseDate = toCivilDate(expense.expenseDate);
      return (
        expenseDate.getUTCFullYear() === calculationYear &&
        expenseDate.getUTCMonth() + 1 === calculationMonth
      );
    })
    .map((expense) => {
      const effectiveMarginBps = resolveMarginBps({
        expenseMarginBps: expense.safetyMarginOverrideBps,
        categoryMarginBps: categoryMargin(expense),
        householdMarginBps,
      });
      return {
        id: expense.id,
        name: expense.name,
        category: expense.category,
        type: 'ONE_TIME',
        scope: expense.scope ?? 'HOUSEHOLD',
        personalPersonId: expense.personalPersonId ?? null,
        baseCents: expense.amountCents,
        effectiveMarginBps,
        amountCents: applyMarginCents(expense.amountCents, effectiveMarginBps),
        expenseDate: expense.expenseDate,
      };
    });

  const lines = [...recurringLines, ...invoiceLines, ...variableLines, ...oneTimeLines];
  const householdLines = lines.filter((line) => line.scope === 'HOUSEHOLD');
  const personalLines = lines.filter((line) => line.scope === 'PERSONAL');
  const householdBaseBudgetCents = householdLines.reduce(
    (sum, line) => sum + line.baseCents,
    0,
  );
  const personalBaseBudgetCents = personalLines.reduce(
    (sum, line) => sum + line.baseCents,
    0,
  );
  const householdBudgetCents = householdLines.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  const personalTotals = sumByPerson(personalLines);
  const activePeople = people.filter((person) => person.isActive !== false && !person.archivedAt);
  const shares = splitAmount(householdBudgetCents, activePeople);
  const shareMap = new Map(shares.map((share) => [share.id, share.amountCents]));
  const contributions = activePeople.map((person) => {
    const standardHouseholdCents = shareMap.get(person.id) ?? 0;
    const personalExpenseCents = personalTotals.get(person.id) ?? 0;
    return {
      personId: person.id,
      personName: person.name,
      contributionBps: person.contributionBps,
      standardHouseholdCents,
      personalExpenseCents,
      totalStandardCents: standardHouseholdCents + personalExpenseCents,
    };
  });

  return {
    calculationVersion: 'v1',
    householdBudgetCents,
    householdBaseBudgetCents,
    householdMarginCents: householdBudgetCents - householdBaseBudgetCents,
    personalBudgetCents: [...personalTotals.values()].reduce((sum, value) => sum + value, 0),
    personalBaseBudgetCents,
    personalMarginCents:
      [...personalTotals.values()].reduce((sum, value) => sum + value, 0) -
      personalBaseBudgetCents,
    recommendedBudgetCents:
      householdBudgetCents + [...personalTotals.values()].reduce((sum, value) => sum + value, 0),
    contributions,
    lines,
    sourceCoverage: {
      recurringCount: recurringLines.length,
      invoiceCategoryCount: invoiceLines.length,
      variableCategoryCount: variableLines.length,
      oneTimeCount: oneTimeLines.length,
      latestVariableMonth: variableLines
        .map((line) => line.statistics.latestMonth)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
      latestInvoiceMonth: invoiceLines
        .map((line) => line.statistics.latestInvoice?.periodEnd)
        .filter(Boolean)
        .map(monthKey)
        .sort()
        .at(-1) ?? null,
    },
  };
}
