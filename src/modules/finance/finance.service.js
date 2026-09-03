import { calculateMonthlyStandardBudget } from '../../services/budgetCalculator.service.js';
import { toCivilDate, toIsoDate } from '../../services/date.service.js';
import {
  calculateFinancialStatus,
  calculateSimulation,
  calculateTheoreticalReserve,
} from '../../services/planningCalculator.service.js';

const recurringInclude = Object.freeze({
  category: true,
  personalPerson: {
    select: { id: true, name: true, contributionBps: true, isActive: true },
  },
});

function groupBy(items, keyFor) {
  const groups = new Map();
  items.forEach((item) => {
    const key = keyFor(item);
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  });
  return groups;
}

export function dateOrToday(value) {
  if (value) return toCivilDate(value);
  return toCivilDate(new Date());
}

export async function loadFinancialInputs(database, householdId) {
  const [household, recurringExpenses, invoices, variableMonths] =
    await Promise.all([
      database.household.findUnique({
        where: { id: householdId },
        include: {
          people: {
            where: { isActive: true, archivedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      }),
      database.recurringExpense.findMany({
        where: { householdId, isActive: true, archivedAt: null },
        include: recurringInclude,
        orderBy: [{ nextDueDate: 'asc' }, { name: 'asc' }],
      }),
      database.utilityInvoice.findMany({
        where: { householdId },
        include: { category: true },
        orderBy: [{ periodEnd: 'asc' }, { createdAt: 'asc' }],
      }),
      database.variableExpenseMonth.findMany({
        where: { householdId },
        include: {
          category: true,
          personalPerson: { select: { id: true, name: true } },
          entries: { orderBy: [{ spentOn: 'asc' }, { createdAt: 'asc' }] },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
    ]);

  const invoicesByCategory = groupBy(invoices, (invoice) => invoice.categoryId);
  const invoiceGroups = [...invoicesByCategory.entries()].map(
    ([categoryId, categoryInvoices]) => ({
      categoryId,
      category: categoryInvoices[0].category,
      invoices: categoryInvoices,
    }),
  );
  const variablesByOwner = groupBy(
    variableMonths,
    (item) => `${item.categoryId}:${item.ownerKey}`,
  );
  const variableGroups = [...variablesByOwner.values()].map((months) => ({
    categoryId: months[0].categoryId,
    category: months[0].category,
    ownerKey: months[0].ownerKey,
    scope: months[0].scope,
    personalPersonId: months[0].personalPersonId,
    months,
  }));

  return {
    household,
    recurringExpenses,
    invoices,
    variableMonths,
    invoiceGroups,
    variableGroups,
  };
}

export function getBudgetReadiness(household) {
  const people = household?.people ?? [];
  const percentageTotal = people.reduce(
    (total, person) => total + person.contributionBps,
    0,
  );
  const missing = [];

  if (people.length === 0) missing.push('PEOPLE');
  if (household?.contributionMode !== 'PERCENTAGE') {
    missing.push('PERCENTAGE_MODE');
  } else if (people.length > 0 && percentageTotal !== 10_000) {
    missing.push('CONTRIBUTION_DISTRIBUTION');
  }

  return {
    ready: missing.length === 0,
    missing,
    activePeople: people.length,
    contributionBpsTotal: percentageTotal,
  };
}

export function calculateBudgetFromInputs(inputs, calculationDate = new Date()) {
  const date = dateOrToday(calculationDate);
  const readiness = getBudgetReadiness(inputs.household);
  if (!readiness.ready) {
    return {
      readiness,
      calculationVersion: 'v1',
      householdBudgetCents: null,
      personalBudgetCents: null,
      recommendedBudgetCents: null,
      contributions: [],
      lines: [],
      sourceCoverage: {
        recurringCount: inputs.recurringExpenses.length,
        invoiceCategoryCount: inputs.invoiceGroups.length,
        variableCategoryCount: inputs.variableGroups.length,
      },
    };
  }

  return {
    readiness,
    ...calculateMonthlyStandardBudget({
      calculationDate: date,
      householdMarginBps: inputs.household.safetyMarginBps,
      people: inputs.household.people,
      recurringExpenses: inputs.recurringExpenses,
      invoiceGroups: inputs.invoiceGroups,
      variableGroups: inputs.variableGroups,
    }),
  };
}

export async function calculateHouseholdBudget(database, householdId, calculationDate) {
  const inputs = await loadFinancialInputs(database, householdId);
  return { inputs, budget: calculateBudgetFromInputs(inputs, calculationDate) };
}

export function upcomingPayments(recurringExpenses, calculationDate) {
  const date = toCivilDate(calculationDate);
  return recurringExpenses
    .filter((expense) => expense.nextDueDate >= date)
    .map((expense) => ({
      expenseId: expense.id,
      name: expense.name,
      dueDate: toIsoDate(expense.nextDueDate),
      amountCents: expense.amountCents,
      scope: expense.scope,
      category: expense.category,
    }))
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

export function dashboardDuePayments(recurringExpenses, calculationDate, daysAhead = 5) {
  const date = toCivilDate(calculationDate);
  const horizon = new Date(date);
  horizon.setUTCDate(horizon.getUTCDate() + daysAhead);

  return recurringExpenses
    .filter(
      (expense) =>
        expense.isActive !== false &&
        !expense.archivedAt &&
        toCivilDate(expense.nextDueDate) <= horizon,
    )
    .map((expense) => ({
      expenseId: expense.id,
      name: expense.name,
      dueDate: toIsoDate(expense.nextDueDate),
      amountCents: expense.amountCents,
      scope: expense.scope,
      category: expense.category,
    }))
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

export async function calculateDashboard(
  database,
  householdId,
  calculationDate,
  balanceOverride,
) {
  const date = dateOrToday(calculationDate);
  const { inputs, budget } = await calculateHouseholdBudget(database, householdId, date);
  const balanceCents = balanceOverride ?? inputs.household.currentBalanceCents;
  const reserve = calculateTheoreticalReserve(inputs.recurringExpenses, date);
  const payments = dashboardDuePayments(inputs.recurringExpenses, date);
  const health = calculateFinancialStatus({
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    relevantAvailableBalanceCents: balanceCents,
    upcomingPayments: payments,
  });
  const planning = await database.monthlyPlanning.findUnique({
    where: {
      householdId_year_month: {
        householdId,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
      },
    },
    include: { contributions: { orderBy: { personName: 'asc' } } },
  });
  const activeRecoveryPlan = await database.recoveryPlan.findFirst({
    where: { householdId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });

  return {
    household: {
      id: inputs.household.id,
      name: inputs.household.name,
      currency: inputs.household.currency,
      safetyMarginBps: inputs.household.safetyMarginBps,
      contributionDay: inputs.household.contributionDay,
    },
    calculationDate: toIsoDate(date),
    budget,
    balanceCents,
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    reserveLines: reserve.lines,
    deficitCents: health.deficitCents,
    financialStatus: health.financialStatus,
    nextPayment: health.nextPayment,
    upcomingPayments: payments.slice(0, 10),
    planning,
    activeRecoveryPlan,
  };
}

export async function calculateHouseholdSimulation(
  database,
  householdId,
  simulationDate,
  balanceOverride,
) {
  const date = dateOrToday(simulationDate);
  const { inputs, budget } = await calculateHouseholdBudget(database, householdId, date);
  if (!budget.readiness.ready) {
    return {
      simulationDate: toIsoDate(date),
      readiness: budget.readiness,
      monthlyStandardBudgetCents: null,
    };
  }
  return {
    readiness: budget.readiness,
    ...calculateSimulation({
      standardBudget: budget,
      recurringExpenses: inputs.recurringExpenses,
      simulationDate: date,
      relevantAvailableBalanceCents:
        balanceOverride ?? inputs.household.currentBalanceCents,
    }),
  };
}

export function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
