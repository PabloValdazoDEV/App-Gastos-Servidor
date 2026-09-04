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

export function visibleExpenseWhere(actorUserId, scope) {
  const scopeWhere = scope
    ? scope === 'HOUSEHOLD'
      ? { scope: 'HOUSEHOLD' }
      : { scope: 'PERSONAL', personalPerson: { linkedUserId: actorUserId } }
    : null;
  if (!actorUserId) return scopeWhere ?? {};
  if (scopeWhere) return scopeWhere;
  return {
    OR: [
      { scope: 'HOUSEHOLD' },
      { scope: 'PERSONAL', personalPerson: { linkedUserId: actorUserId } },
    ],
  };
}

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

export function sanitizePlanningForViewer(planning, actorUserId, people = []) {
  if (!planning || !actorUserId) return planning;
  const viewerPersonId = people.find((person) => person.linkedUserId === actorUserId)?.id;
  return {
    ...planning,
    // The stored breakdown can contain every personal line. It is only an
    // internal calculation artifact, so never send it to a household member.
    breakdown: null,
    contributions: (planning.contributions ?? []).map((contribution) => {
      if (contribution.householdPersonId === viewerPersonId) return contribution;
      return {
        ...contribution,
        confirmedPersonalBalanceCents: null,
        personalExpenseCents: 0,
        totalRecommendedCents:
          contribution.standardHouseholdCents + contribution.temporaryAdjustmentCents,
      };
    }),
  };
}

export function planningMatchesBudget(planning, budget) {
  if (!planning) return false;

  const plannedContributions = [...(planning.contributions ?? [])].sort((left, right) =>
    left.householdPersonId.localeCompare(right.householdPersonId),
  );
  const budgetContributions = [...(budget?.contributions ?? [])].sort((left, right) =>
    left.personId.localeCompare(right.personId),
  );

  return plannedContributions.length === budgetContributions.length && plannedContributions.every(
    (contribution, index) => {
      const budgetContribution = budgetContributions[index];
      return (
        contribution.householdPersonId === budgetContribution.personId &&
        contribution.contributionBps === budgetContribution.contributionBps
      );
    },
  );
}

export function rebasePlanningToBudget(planning, budget) {
  if (!planning) return null;

  const previousContributions = new Map(
    (planning.contributions ?? []).map((contribution) => [
      contribution.householdPersonId,
      contribution,
    ]),
  );
  return {
    ...planning,
    recommendedBudgetCents: budget.recommendedBudgetCents,
    householdBudgetCents: budget.householdBudgetCents,
    contributions: budget.contributions.map((contribution) => {
      const previous = previousContributions.get(contribution.personId);
      const temporaryAdjustmentCents = previous?.temporaryAdjustmentCents ?? 0;
      return {
        ...previous,
        householdPersonId: contribution.personId,
        personName: contribution.personName,
        contributionBps: contribution.contributionBps,
        standardHouseholdCents: contribution.standardHouseholdCents,
        personalExpenseCents: contribution.personalExpenseCents,
        temporaryAdjustmentCents,
        totalRecommendedCents: contribution.totalStandardCents + temporaryAdjustmentCents,
      };
    }),
  };
}

export function dateOrToday(value) {
  if (value) return toCivilDate(value);
  return toCivilDate(new Date());
}

export function availableCommonBalance(inputs, balanceOverride) {
  if (balanceOverride !== undefined) return balanceOverride;
  const accounts = inputs.accounts ?? [];
  if (!accounts.some((account) => account.scope === 'HOUSEHOLD')) {
    return inputs.household.currentBalanceCents;
  }
  return accounts
    .filter((account) => account.scope === 'HOUSEHOLD')
    .reduce((sum, account) => sum + account.balanceCents, 0);
}

export async function loadFinancialInputs(database, householdId, actorUserId) {
  const [household, recurringExpenses, invoices, variableMonths, oneTimeExpenses, accounts] =
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
        where: {
          householdId,
          isActive: true,
          archivedAt: null,
          ...visibleExpenseWhere(actorUserId),
        },
        include: recurringInclude,
        orderBy: [{ nextDueDate: 'asc' }, { name: 'asc' }],
      }),
      database.utilityInvoice.findMany({
        where: { householdId, ...visibleExpenseWhere(actorUserId) },
        include: {
          category: true,
          personalPerson: { select: { id: true, name: true } },
        },
        orderBy: [{ periodEnd: 'asc' }, { createdAt: 'asc' }],
      }),
      database.variableExpenseMonth.findMany({
        where: { householdId, ...visibleExpenseWhere(actorUserId) },
        include: {
          category: true,
          personalPerson: { select: { id: true, name: true } },
          entries: { orderBy: [{ spentOn: 'asc' }, { createdAt: 'asc' }] },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
      database.oneTimeExpense?.findMany
        ? database.oneTimeExpense.findMany({
            where: { householdId, ...visibleExpenseWhere(actorUserId) },
            include: {
              category: true,
              personalPerson: { select: { id: true, name: true } },
            },
            orderBy: [{ expenseDate: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([]),
      database.householdAccount?.findMany
        ? database.householdAccount.findMany({
            where: {
              householdId,
              isActive: true,
              ...(actorUserId
                ? {
                    OR: [
                      { scope: 'HOUSEHOLD' },
                      { scope: 'PERSONAL', personalPerson: { linkedUserId: actorUserId } },
                    ],
                  }
                : {}),
            },
            include: { personalPerson: { select: { id: true, name: true } } },
            orderBy: [{ scope: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

  const invoicesByCategory = groupBy(
    invoices,
    (invoice) => `${invoice.categoryId}:${invoice.scope === 'PERSONAL' ? invoice.personalPersonId : 'HOUSEHOLD'}`,
  );
  const invoiceGroups = [...invoicesByCategory.entries()].map(
    ([, categoryInvoices]) => ({
      categoryId: categoryInvoices[0].categoryId,
      category: categoryInvoices[0].category,
      scope: categoryInvoices[0].scope,
      personalPersonId: categoryInvoices[0].personalPersonId,
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
    oneTimeExpenses,
    accounts,
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
        oneTimeCount: inputs.oneTimeExpenses?.length ?? 0,
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
      oneTimeExpenses: inputs.oneTimeExpenses,
    }),
  };
}

export async function calculateHouseholdBudget(
  database,
  householdId,
  calculationDate,
  actorUserId,
) {
  const inputs = await loadFinancialInputs(database, householdId, actorUserId);
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
  actorUserId,
) {
  const date = dateOrToday(calculationDate);
  const { inputs, budget } = await calculateHouseholdBudget(
    database,
    householdId,
    date,
    actorUserId,
  );
  const accounts = inputs.accounts ?? [];
  const hasCommonAccounts = accounts.some((account) => account.scope === 'HOUSEHOLD');
  const viewerPersonId = actorUserId
    ? inputs.household.people.find((person) => person.linkedUserId === actorUserId)?.id
    : null;
  const personalAccountBalances = new Map();
  accounts
    .filter((account) => account.scope === 'PERSONAL' && account.personalPersonId)
    .forEach((account) => {
      personalAccountBalances.set(
        account.personalPersonId,
        (personalAccountBalances.get(account.personalPersonId) ?? 0) + account.balanceCents,
      );
    });
  const planningRecord = await database.monthlyPlanning.findUnique({
    where: {
      householdId_year_month: {
        householdId,
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
      },
    },
    include: { contributions: { orderBy: { personName: 'asc' } } },
  });
  const balanceCents =
    balanceOverride === undefined &&
    planningRecord &&
    planningRecord.confirmedBalanceCents !== null
      ? planningRecord.confirmedBalanceCents
      : availableCommonBalance(inputs, balanceOverride);
  const reserve = calculateTheoreticalReserve(inputs.recurringExpenses, date);
  const payments = dashboardDuePayments(inputs.recurringExpenses, date);
  const health = calculateFinancialStatus({
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    relevantAvailableBalanceCents: balanceCents,
    upcomingPayments: payments,
  });
  const monthlyPersonalBalances = new Map(
    (planningRecord?.contributions ?? [])
      .filter((contribution) => contribution.confirmedPersonalBalanceCents !== null)
      .map((contribution) => [
        contribution.householdPersonId,
        contribution.confirmedPersonalBalanceCents,
      ]),
  );
  const hasMonthlyPersonalBalances =
    Boolean(planningRecord) &&
    budget.contributions.length > 0 &&
    budget.contributions.every((contribution) => monthlyPersonalBalances.has(contribution.personId));
  const planningIsUsable = Boolean(planningRecord) && hasMonthlyPersonalBalances;
  const planning = planningIsUsable
    ? sanitizePlanningForViewer(
        planningMatchesBudget(planningRecord, budget)
          ? planningRecord
          : rebasePlanningToBudget(planningRecord, budget),
        actorUserId,
        inputs.household.people,
      )
    : null;
  const hasAccounts = accounts.length > 0 || hasMonthlyPersonalBalances;
  const activeRecoveryPlan = await database.recoveryPlan.findFirst({
    where: { householdId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
  const accountSummary = {
    hasAccounts,
    hasCommonAccounts,
    common: {
      balanceCents,
      requiredCents: budget.householdBudgetCents ?? 0,
      differenceCents:
        balanceCents - (budget.householdBudgetCents ?? 0),
      status:
        balanceCents >= (budget.householdBudgetCents ?? 0) ? 'OK' : 'DEFICIT',
    },
    personal: (budget.contributions ?? [])
      .filter((contribution) => !actorUserId || contribution.personId === viewerPersonId)
      .map((contribution) => {
        const balance = hasMonthlyPersonalBalances
          ? monthlyPersonalBalances.get(contribution.personId)
          : personalAccountBalances.get(contribution.personId) ?? 0;
        const required = contribution.totalStandardCents;
        return {
          personId: contribution.personId,
          personName: contribution.personName,
          balanceCents: balance,
          requiredCents: required,
          differenceCents: balance - required,
          status: balance >= required ? 'OK' : 'DEFICIT',
        };
      }),
  };

  return {
    household: {
      id: inputs.household.id,
      name: inputs.household.name,
      currency: inputs.household.currency,
      safetyMarginBps: inputs.household.safetyMarginBps,
      contributionDay: inputs.household.contributionDay,
      contributionMode: inputs.household.contributionMode,
    },
    calculationDate: toIsoDate(date),
    budget,
    balanceCents,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      scope: account.scope,
      personalPersonId: account.personalPersonId,
      personalPerson: account.personalPerson,
      balanceCents: account.balanceCents,
    })),
    accountSummary,
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
  actorUserId,
) {
  const date = dateOrToday(simulationDate);
  const { inputs, budget } = await calculateHouseholdBudget(
    database,
    householdId,
    date,
    actorUserId,
  );
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
        availableCommonBalance(inputs, balanceOverride),
    }),
  };
}

export function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
