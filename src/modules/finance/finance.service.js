import { calculateMonthlyStandardBudget } from '../../services/budgetCalculator.service.js';
import { businessToday } from '../../services/businessClock.service.js';
import { variableForecastWindow } from '../../services/variableForecast.service.js';
import { activePlanning, comparePlanningBudget, hasFundingConfirmation, planningFunding, publicBudgetLines } from './planningSnapshot.js';
import { extraFunding, publicPlanningExtras } from './planningExtras.js';
import { addCalendarDays, addCalendarMonths, startOfMonth, toCivilDate, toIsoDate } from '../../services/date.service.js';
import { calculateMonthlySpendingProgress } from '../../services/monthlySpendingProgress.service.js';
import { calculateMonthlyOverview } from '../../services/monthlyOverview.service.js';
import { budgetMarginLookup } from './budgetMarginPreference.service.js';
import { loadPurchaseFinancialSources, upcomingPurchasePayments } from './purchaseFinancialSources.js';
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

function sanitizePlanningView(planning, actorUserId) {
  if (!planning || !actorUserId) return planning;
  const identities = planning.breakdown?.personIdentitySnapshot;
  const canViewPersonal = (contribution) => Array.isArray(identities) && identities.some((identity) =>
    identity.personId === contribution.householdPersonId && identity.linkedUserId === actorUserId);
  return {
    ...planning,
    // The original total also includes other people's private budget. Redacting
    // only its lines would still expose that amount by subtraction.
    recommendedBudgetCents: planning.householdBudgetCents + (
      planning.contributions?.filter(canViewPersonal).reduce((sum, item) => sum + item.personalExpenseCents, 0) ?? 0
    ),
    personalHistoryRequiresConfirmation: !Array.isArray(identities),
    budgetLines: publicBudgetLines(planning.breakdown?.budget?.lines, (personId) =>
      canViewPersonal({ householdPersonId: personId })),
    // The stored breakdown can contain every personal line. It is only an
    // internal calculation artifact, so never send it to a household member.
    breakdown: null,
    contributions: (planning.contributions ?? []).map((contribution) => {
      const visible = canViewPersonal(contribution) ? contribution : {
        ...contribution,
        confirmedPersonalBalanceCents: null,
        personalExpenseCents: 0,
        totalRecommendedCents:
          contribution.standardHouseholdCents + contribution.temporaryAdjustmentCents,
      };
      return { ...visible, personalAmountsHidden: !canViewPersonal(contribution), funding: planningFunding(planning, visible),
        canConfirmPersonal: canViewPersonal(contribution) };
    }),
  };
}

export function sanitizePlanningForViewer(original, actorUserId) {
  if (!original) return original;
  const planning = activePlanning(original);
  if (!actorUserId) return planning;
  const visible = sanitizePlanningView(planning, actorUserId);
  const extras = publicPlanningExtras(original);
  const revisions = original.breakdown?.revisions ?? [];
  const ownIds = new Set((original.breakdown?.personIdentitySnapshot ?? []).filter((item) =>
    item.linkedUserId === actorUserId).map((item) => item.personId));
  const historyItem = (source, revision, at, reason) => {
    const view = sanitizePlanningView(source, actorUserId);
    return { revision, at, reason, householdBudgetCents: view.householdBudgetCents,
      recommendedBudgetCents: view.recommendedBudgetCents,
      contributions: view.contributions.map(({ personName, householdPersonId, standardHouseholdCents, personalExpenseCents, temporaryAdjustmentCents, totalRecommendedCents, personalAmountsHidden }) =>
        ({ personName, householdPersonId, standardHouseholdCents, personalExpenseCents, temporaryAdjustmentCents, totalRecommendedCents, personalAmountsHidden })) };
  };
  return {
    ...visible,
    extras,
    extraFunding: extraFunding(extras),
    contributions: visible.contributions.map((item) => {
      const extra = extraFunding(extras, item.householdPersonId);
      return { ...item, extraFunding: extra, totalPendingCents: item.funding.pendingCents + extra.pendingCents,
        totalConfirmedCents: item.funding.confirmedCents + extra.confirmedCents };
    }),
    stateVersion: original.breakdown?.stateVersion ?? 0,
    revision: revisions.length,
    canRevise: !hasFundingConfirmation(planning) && !extras.some((item) => !item.cancelledAt) && Array.isArray(original.breakdown?.personIdentitySnapshot),
    revisionHistory: [historyItem(original, 0, original.preparedAt, null), ...revisions.map((record, index) =>
      historyItem(activePlanning({ ...original, breakdown: { ...original.breakdown, revisions: [record] } }), index + 1, record.at, record.reason))],
    fundingHistory: (original.breakdown?.fundingEvents ?? []).filter((event) =>
      event.scope !== 'PERSONAL' || event.personIds?.some((id) => ownIds.has(id)))
      .map(({ action, scope, at, reason, revision }) => ({ action, scope, at, reason, revision })),
  };
}

export function planningMatchesBudget(planning, budget) {
  if (!planning) return false;

  if (Array.isArray(planning.budgetLines) && Array.isArray(budget?.lines)) {
    const amounts = new Map(planning.budgetLines.map((line) => [`${line.type}:${line.id}`, line.amountCents]));
    if (amounts.size !== budget.lines.length || budget.lines.some((line) =>
      amounts.get(`${line.type}:${line.id}`) !== line.amountCents)) return false;
  }

  const plannedContributions = [...(planning.contributions ?? [])].sort((left, right) =>
    left.householdPersonId.localeCompare(right.householdPersonId),
  );
  const budgetContributions = [...(budget?.contributions ?? [])].sort((left, right) =>
    left.personId.localeCompare(right.personId),
  );

  return planning.householdBudgetCents === budget?.householdBudgetCents &&
    planning.recommendedBudgetCents === budget?.recommendedBudgetCents &&
    plannedContributions.length === budgetContributions.length && plannedContributions.every(
    (contribution, index) => {
      const budgetContribution = budgetContributions[index];
      return (
        contribution.householdPersonId === budgetContribution.personId &&
        contribution.contributionBps === budgetContribution.contributionBps &&
        contribution.standardHouseholdCents === budgetContribution.standardHouseholdCents &&
        contribution.personalExpenseCents === budgetContribution.personalExpenseCents
      );
    },
  );
}

export function rebasePlanningToBudget(planning, budget) {
  if (!planning) return null;
  // Kept as an API-compatible export: changes are now reported separately.
  // Never replace the original amounts, even for an unfunded prepared month.
  return {
    ...planning,
    budgetChangedSincePreparation: true,
    preparedHouseholdBudgetCents: planning.householdBudgetCents,
    budgetComparison: comparePlanningBudget(planning, budget),
  };
}

export function dateOrToday(value) {
  if (value) return toCivilDate(value);
  return businessToday();
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

export function personalAccountRequiredCents(contribution) {
  return contribution.personalExpenseCents ?? 0;
}

export async function loadFinancialInputs(database, householdId, actorUserId, calculationDate = businessToday()) {
  const firstDay = startOfMonth(calculationDate);
  const [household, recurringExpenses, invoices, variableMonths, oneTimeExpenses, accounts, preferences, purchaseSources] =
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
      database.budgetMarginPreference.findMany({
        where: { householdId, ...visibleExpenseWhere(actorUserId) },
      }),
      loadPurchaseFinancialSources(database, {
        householdId, actorUserId, from: firstDay,
        to: addCalendarDays(addCalendarMonths(firstDay, 12), -1), includeOverdue: true,
      }),
    ]);

  const appliesMargin = budgetMarginLookup(preferences);

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
      applySafetyMargin: appliesMargin('INVOICE', categoryInvoices[0]),
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
    applySafetyMargin: appliesMargin('VARIABLE', months[0]),
  }));

  return {
    household,
    recurringExpenses,
    invoices,
    variableMonths,
    oneTimeExpenses,
    purchaseSources,
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

export function calculateBudgetFromInputs(inputs, calculationDate = businessToday()) {
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
        purchaseCount: inputs.purchaseSources?.length ?? 0,
      },
    };
  }

  return {
    readiness,
    ...calculateMonthlyStandardBudget({
      calculationDate: date,
      ...variableForecastWindow(date, businessToday(inputs.household.timezone ?? 'UTC')),
      householdMarginBps: inputs.household.safetyMarginBps,
      people: inputs.household.people,
      recurringExpenses: inputs.recurringExpenses,
      invoiceGroups: inputs.invoiceGroups,
      variableGroups: inputs.variableGroups,
      oneTimeExpenses: inputs.oneTimeExpenses,
      purchaseSources: inputs.purchaseSources,
    }),
  };
}

export async function calculateHouseholdBudget(
  database,
  householdId,
  calculationDate,
  actorUserId,
) {
  const inputs = await loadFinancialInputs(database, householdId, actorUserId, dateOrToday(calculationDate));
  const budget = calculateBudgetFromInputs(inputs, calculationDate);
  if (actorUserId) {
    // Other personal sources were excluded at query time. Their zero is a
    // redaction placeholder, not evidence that this person has no expenses.
    const ownIds = new Set(inputs.household.people.filter((person) =>
      person.linkedUserId === actorUserId).map((person) => person.id));
    budget.contributions = budget.contributions.map((contribution) => ({
      ...contribution, personalAmountsHidden: !ownIds.has(contribution.personId),
    }));
  }
  return { inputs, budget };
}

export function upcomingPayments(recurringExpenses, calculationDate, purchaseSources = []) {
  const date = toCivilDate(calculationDate);
  return [...recurringExpenses
    .filter((expense) => toCivilDate(expense.nextDueDate) >= date)
    .map((expense) => ({
      sourceType: 'RECURRING_EXPENSE',
      expenseId: expense.id,
      name: expense.name,
      dueDate: toIsoDate(expense.nextDueDate),
      amountCents: expense.amountCents,
      scope: expense.scope,
      category: expense.category,
    })), ...upcomingPurchasePayments(purchaseSources, date)]
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

export function dashboardDuePayments(recurringExpenses, calculationDate, daysAhead = 5, purchaseSources = []) {
  const date = toCivilDate(calculationDate);
  const horizon = new Date(date);
  horizon.setUTCDate(horizon.getUTCDate() + daysAhead);

  return [...recurringExpenses
    .filter(
      (expense) =>
        expense.isActive !== false &&
        !expense.archivedAt &&
        toCivilDate(expense.nextDueDate) <= horizon,
    )
    .map((expense) => ({
      sourceType: 'RECURRING_EXPENSE',
      expenseId: expense.id,
      name: expense.name,
      dueDate: toIsoDate(expense.nextDueDate),
      amountCents: expense.amountCents,
      scope: expense.scope,
      category: expense.category,
    })), ...upcomingPurchasePayments(purchaseSources, date, { includeOverdue: true, daysAhead })]
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate));
}

export function loadMonthlyProgressPayments(database, householdId, calculationDate, actorUserId) {
  const firstDay = startOfMonth(calculationDate);
  return database.expensePayment.findMany({
    where: {
      dueDate: { gte: firstDay, lt: addCalendarMonths(firstDay, 1) },
      // Do not filter active/archived: an archived expense still consumed this
      // month's budget. Parent ownership remains the authorization boundary.
      recurringExpense: { householdId, ...visibleExpenseWhere(actorUserId) },
    },
    // Include omitted occurrences as well, so the month never forecasts them
    // again. The legacy progress calculator still counts only PAID records.
    include: { recurringExpense: { include: { category: true } } },
  });
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
  const [planningRecord, activeRecoveryPlan, monthlyPayments] = await Promise.all([
    database.monthlyPlanning.findUnique({
      where: {
        householdId_year_month: {
          householdId,
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
        },
      },
      include: { contributions: { orderBy: { personName: 'asc' } } },
    }),
    database.recoveryPlan.findFirst({
      where: { householdId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    }),
    loadMonthlyProgressPayments(database, householdId, date, actorUserId),
  ]);
  const balanceCents =
    balanceOverride === undefined &&
    planningRecord &&
    planningRecord.confirmedBalanceCents !== null
      ? planningRecord.confirmedBalanceCents
      : availableCommonBalance(inputs, balanceOverride);
  const reserve = calculateTheoreticalReserve(inputs.recurringExpenses, date);
  const payments = dashboardDuePayments(inputs.recurringExpenses, date, 5, inputs.purchaseSources);
  const health = calculateFinancialStatus({
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    relevantAvailableBalanceCents: balanceCents,
    upcomingPayments: payments,
  });
  const monthlyPersonalBalances = new Map(
    (sanitizePlanningForViewer(planningRecord, actorUserId)?.contributions ?? [])
      .filter((contribution) => contribution.confirmedPersonalBalanceCents !== null)
      .map((contribution) => [
        contribution.householdPersonId,
        contribution.confirmedPersonalBalanceCents,
      ]),
  );
  const hasMonthlyPersonalBalances =
    Boolean(planningRecord) &&
    budget.contributions.length > 0 &&
    budget.contributions.every((contribution) => (planningRecord.contributions ?? []).some((previous) =>
      previous.householdPersonId === contribution.personId && previous.confirmedPersonalBalanceCents !== null));
  const visiblePlanning = sanitizePlanningForViewer(planningRecord, actorUserId, inputs.household.people);
  const planning = planningRecord
    ? !budget.readiness.ready || planningMatchesBudget(visiblePlanning, budget)
      ? visiblePlanning
      : rebasePlanningToBudget(visiblePlanning, budget)
    : null;
  const hasAccounts = accounts.length > 0 || hasMonthlyPersonalBalances;
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
        const balance = hasMonthlyPersonalBalances && monthlyPersonalBalances.has(contribution.personId)
          ? monthlyPersonalBalances.get(contribution.personId)
          : personalAccountBalances.get(contribution.personId) ?? 0;
        const required = personalAccountRequiredCents(contribution);
        return {
          personId: contribution.personId,
          personName: contribution.personName,
          jointContributionCents: contribution.standardHouseholdCents ?? 0,
          balanceCents: balance,
          requiredCents: required,
          differenceCents: balance - required,
          status: balance >= required ? 'OK' : 'DEFICIT',
        };
      }),
  };

  const viewerContribution = budget.contributions.find(
    (contribution) => contribution.personId === viewerPersonId,
  );
  const hasViewerPurchaseHistory = Boolean(actorUserId) && inputs.purchaseSources.some((source) => source.scope === 'PERSONAL');
  const hasViewerAccount = personalAccountBalances.has(viewerPersonId);
  const viewerBalanceCents = hasViewerAccount
    ? personalAccountBalances.get(viewerPersonId)
    : monthlyPersonalBalances.get(viewerPersonId) ?? null;
  const monthlyOverview = calculateMonthlyOverview({
    ...inputs,
    calculationDate: date,
    payments: monthlyPayments,
    budgetLines: budget.lines,
    viewerPersonId,
    includeViewerPurchaseHistory: hasViewerPurchaseHistory,
    commonBalanceCents: availableCommonBalance(inputs, balanceOverride),
    commonBalanceSource: balanceOverride !== undefined ? 'OVERRIDE' : hasCommonAccounts ? 'ACCOUNTS' : 'HOUSEHOLD',
    // A month's old confirmed balance is not a current personal account balance.
    personalBalanceCents: hasViewerAccount ? personalAccountBalances.get(viewerPersonId) : null,
  });
  const progress = calculateMonthlySpendingProgress({
    calculationDate: date,
    // Always use today's recommendation (including margins and one-offs), not
    // a frozen planning contribution or its temporary recovery adjustment.
    commonBudgetCents: budget.householdBudgetCents,
    personalBudgetCents: viewerContribution?.personalExpenseCents ?? (hasViewerPurchaseHistory ? budget.personalBudgetCents : null),
    viewerPersonId,
    includeViewerPurchaseHistory: hasViewerPurchaseHistory,
    payments: monthlyPayments,
    variableMonths: inputs.variableMonths,
    invoices: inputs.invoices,
    purchaseSources: inputs.purchaseSources,
    // Live registered accounts must win over the month's old preparation.
    // Preparation also updates household.currentBalanceCents, our common fallback.
    commonBalanceCents: availableCommonBalance(inputs, balanceOverride),
    personalBalanceCents: viewerBalanceCents,
  });
  if (progress.monthlyProgress?.personal) {
    progress.monthlyProgress.personal.personName = viewerContribution?.personName ?? 'Tú';
  }
  if (progress.cashCoverage) {
    progress.cashCoverage.common.balanceSource = balanceOverride !== undefined
      ? 'OVERRIDE'
      : hasCommonAccounts ? 'ACCOUNTS' : 'HOUSEHOLD';
    if (progress.cashCoverage.personal) {
      progress.cashCoverage.personal.personName = viewerContribution?.personName ?? 'Tú';
      progress.cashCoverage.personal.balanceSource = hasViewerAccount
        ? 'ACCOUNTS' : 'MONTHLY_PLANNING';
    }
  }

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
    monthlyOverview,
    ...progress,
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
      purchasePayments: upcomingPurchasePayments(inputs.purchaseSources ?? [], date),
      simulationDate: date,
      relevantAvailableBalanceCents:
        availableCommonBalance(inputs, balanceOverride),
    }),
  };
}

export function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
