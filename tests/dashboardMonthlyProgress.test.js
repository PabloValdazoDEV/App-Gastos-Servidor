import { describe, expect, it, vi } from 'vitest';

import {
  calculateDashboard,
  loadMonthlyProgressPayments,
  sanitizePlanningForViewer,
} from '../src/modules/finance/finance.service.js';

const day = (value) => new Date(`${value}T00:00:00.000Z`);
const people = [
  { id: 'own', linkedUserId: 'viewer', name: 'Yo', contributionBps: 5000 },
  { id: 'other', linkedUserId: 'other-user', name: 'Otra persona', contributionBps: 5000 },
];
const category = { id: 'category', name: 'Hogar', safetyMarginBps: null };
const recurring = (overrides = {}) => ({
  id: 'common', householdId: 'household', category, categoryId: category.id,
  name: 'Alquiler', amountCents: 100_000, scope: 'HOUSEHOLD',
  frequency: 'MONTHLY', nextDueDate: day('2026-09-30'), startDate: day('2026-01-01'),
  isActive: true, archivedAt: null, personalPersonId: null,
  ...overrides,
});
const paid = (overrides = {}) => ({
  status: 'PAID', dueDate: day('2026-09-30'), actualAmountCents: 58_000,
  recurringExpense: { householdId: 'household', scope: 'HOUSEHOLD', personalPersonId: null },
  ...overrides,
});

function matches(record, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((item) => matches(record, item));
    if (key === 'gte') return record >= value;
    if (key === 'lt') return record < value;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return record[key] && matches(record[key], value);
    }
    return record[key] === value;
  });
}

function fixture({ planning = null, payments = [], accounts = [], margin = 0 } = {}) {
  const state = {
    household: { id: 'household', name: 'Casa', currency: 'EUR', safetyMarginBps: margin,
      contributionMode: 'PERCENTAGE', currentBalanceCents: 145_000, people },
    expenses: [recurring(), recurring({ id: 'own-recurring', name: 'Personal', scope: 'PERSONAL',
      amountCents: 20_000, personalPersonId: 'own', personalPerson: people[0] })],
    payments, accounts, invoices: [], variables: [], oneOffs: [], planning,
  };
  const findMany = (key) => vi.fn(async ({ where }) => state[key].filter((item) => matches(item, where)));
  const database = {
    household: { findUnique: vi.fn(async () => state.household) },
    recurringExpense: { findMany: findMany('expenses') },
    expensePayment: { findMany: findMany('payments') },
    utilityInvoice: { findMany: findMany('invoices') },
    variableExpenseMonth: { findMany: findMany('variables') },
    oneTimeExpense: { findMany: findMany('oneOffs') },
    householdAccount: { findMany: findMany('accounts') },
    budgetMarginPreference: { findMany: vi.fn(async () => []) },
    monthlyPlanning: { findUnique: vi.fn(async () => state.planning) },
    recoveryPlan: { findFirst: vi.fn(async () => ({ monthlyAdjustmentCents: 99_999 })) },
  };
  const read = (date = '2026-09-17', actor = 'viewer') => calculateDashboard(database, 'household', date, undefined, actor);
  return { state, database, read };
}

function planningRecord() {
  return {
    confirmedBalanceCents: 999,
    householdBudgetCents: 1,
    recommendedBudgetCents: 777_777,
    breakdown: { private: 'must not leave server', personIdentitySnapshot: people.map((person) => ({ personId: person.id, linkedUserId: person.linkedUserId })) },
    contributions: people.map((person) => ({
      householdPersonId: person.id, personName: person.name, contributionBps: 5000,
      standardHouseholdCents: 50_000, personalExpenseCents: person.id === 'own' ? 20_000 : 70_000,
      confirmedPersonalBalanceCents: person.id === 'own' ? 30_000 : 987_654,
      temporaryAdjustmentCents: 1000, totalRecommendedCents: 121_000,
    })),
  };
}

describe('Dashboard monthly progress integration', () => {
  it('calculates progress without monthly planning and does not invent a personal balance', async () => {
    const result = await fixture().read();
    expect(result.planning).toBeNull();
    expect(result.monthlyProgress.common).toMatchObject({ budgetCents: 100_000, usedCents: 0, remainingCents: 100_000 });
    expect(result.monthlyProgress.personal).toMatchObject({ personId: 'own', personName: 'Yo', budgetCents: 20_000 });
    expect(result.cashCoverage.common).toMatchObject({ balanceCents: 145_000, cushionCents: 45_000, balanceSource: 'HOUSEHOLD' });
    expect(result.cashCoverage.personal).toBeNull();
  });

  it('uses current recommendation, margins and one-offs, never the prepared budget or recovery adjustment', async () => {
    const { state, read } = fixture({ planning: planningRecord(), margin: 1000, payments: [paid()] });
    const before = await read();
    expect(before.monthlyProgress.common).toMatchObject({ budgetCents: 110_000, usedCents: 58_000, remainingCents: 52_000 });
    state.oneOffs.push({ id: 'one-off', householdId: 'household', category,
      scope: 'HOUSEHOLD', amountCents: 12_000, expenseDate: day('2026-09-17'), applySafetyMargin: false });
    const after = await read();
    expect(after.monthlyProgress.common).toMatchObject({ budgetCents: 122_000, usedCents: 58_000, remainingCents: 64_000 });
    expect(after.planning).not.toBeNull();
  });

  it('updates current account coverage while preserving legacy preparation fields', async () => {
    const { state, read } = fixture({ planning: planningRecord(), payments: [paid()], accounts: [
      { id: 'joint', householdId: 'household', scope: 'HOUSEHOLD', isActive: true, balanceCents: 145_000 },
      { id: 'personal', householdId: 'household', scope: 'PERSONAL', isActive: true,
        personalPersonId: 'own', personalPerson: people[0], balanceCents: 80_000 },
    ] });
    const before = await read();
    expect(before.balanceCents).toBe(999);
    expect(before.cashCoverage.common).toMatchObject({ balanceCents: 145_000, remainingBudgetCents: 42_000, cushionCents: 103_000, balanceSource: 'ACCOUNTS' });
    expect(before.cashCoverage.personal).toMatchObject({ balanceCents: 80_000, balanceSource: 'ACCOUNTS' });
    state.accounts[0].balanceCents = 30_000;
    expect((await read()).cashCoverage.common).toMatchObject({ balanceCents: 30_000, shortfallCents: 12_000, status: 'SHORTFALL' });
  });

  it('falls back to confirmed personal planning without requiring other people to confirm theirs', async () => {
    const planning = planningRecord();
    planning.contributions[1].confirmedPersonalBalanceCents = null;
    const result = await fixture({ planning }).read();
    expect(result.cashCoverage.personal).toMatchObject({ personId: 'own', balanceCents: 30_000, balanceSource: 'MONTHLY_PLANNING' });
  });

  it('counts archived recurring payments, but never skipped payments, on dueDate not paymentDate', async () => {
    const { read } = fixture({ payments: [
      paid({ actualAmountCents: 1599, paymentDate: day('2026-10-02'),
        recurringExpense: { householdId: 'household', scope: 'HOUSEHOLD', isActive: false, archivedAt: day('2026-09-16') } }),
      paid({ status: 'SKIPPED', actualAmountCents: null }),
      paid({ dueDate: day('2026-10-01'), paymentDate: day('2026-09-30'), actualAmountCents: 9999 }),
    ] });
    expect((await read()).monthlyProgress.common.usedCents).toBe(1599);
  });

  it('recalculates historical amount/status corrections on each request', async () => {
    const { state, read } = fixture({ payments: [paid()] });
    expect((await read()).monthlyProgress.common.usedCents).toBe(58_000);
    state.payments[0].actualAmountCents = 60_000;
    expect((await read()).monthlyProgress.common.usedCents).toBe(60_000);
    state.payments[0].status = 'SKIPPED';
    state.payments[0].actualAmountCents = null;
    expect((await read()).monthlyProgress.common.usedCents).toBe(0);
  });

  it('combines recorded variable and invoice amounts without changing historical recommendations', async () => {
    const { state, read } = fixture({ payments: [paid({ actualAmountCents: 30_000 })] });
    state.variables.push({ householdId: 'household', scope: 'HOUSEHOLD', categoryId: 'variable', category,
      ownerKey: 'HOUSEHOLD', year: 2026, month: 9, entryMode: 'DETAIL', entries: [{ amountCents: 18_000 }] });
    state.invoices.push({ householdId: 'household', scope: 'HOUSEHOLD', categoryId: category.id, category,
      amountCents: 10_000, periodStart: day('2026-08-01'), periodEnd: day('2026-08-31'),
      invoiceDate: day('2026-08-31'), chargeDate: day('2026-09-20') });
    const result = await read();
    expect(result.monthlyProgress.common.usedCents).toBe(58_000);
    expect(result.budget.lines.find((line) => line.type === 'VARIABLE')).toBeUndefined();
  });

  it('filters private data at query time and does not leak other private planning totals', async () => {
    const { state, database, read } = fixture({ planning: planningRecord(), payments: [paid(), paid({
      actualAmountCents: 987_654,
      recurringExpense: { householdId: 'household', scope: 'PERSONAL', personalPersonId: 'other', personalPerson: people[1] },
    })] });
    state.expenses.push(recurring({ id: 'secret', scope: 'PERSONAL', personalPersonId: 'other', personalPerson: people[1], amountCents: 987_654 }));
    const result = await read();
    expect(result.monthlyProgress.personal.usedCents).toBe(0);
    expect(result.monthlyProgress.personal.budgetCents).toBe(20_000);
    expect(result.planning.recommendedBudgetCents).toBe(120_000);
    expect(result.planning).toMatchObject({ budgetChangedSincePreparation: true, preparedHouseholdBudgetCents: 1 });
    expect(result.planning.breakdown).toBeNull();
    expect(JSON.stringify(result)).not.toContain('987654');
    expect(database.expensePayment.findMany.mock.calls[0][0].where.recurringExpense.OR).toContainEqual({ scope: 'PERSONAL', personalPerson: { linkedUserId: 'viewer' } });
  });

  it('returns no personal progress for an unlinked viewer, including internal aggregate preparation', async () => {
    const { read } = fixture();
    const result = await read('2026-09-17', 'unlinked');
    expect(result.monthlyProgress.personal).toBeNull();
    expect(result.cashCoverage.personal).toBeNull();
  });

  it('does not pretend an unconfigured distribution is a zero budget', async () => {
    const { state, read } = fixture();
    state.household = { ...state.household, people: [] };
    const result = await read();
    expect(result.budget.readiness.ready).toBe(false);
    expect(result.monthlyProgress).toBeNull();
    expect(result.cashCoverage).toBeNull();
  });

  it.each([
    ['2026-12-31', '2026-12-01', '2027-01-01'],
    ['2027-01-01', '2027-01-01', '2027-02-01'],
  ])('uses a single bounded payment query for %s, preserving the existing index', async (date, start, end) => {
    const { database, read } = fixture();
    await read(date);
    expect(database.expensePayment.findMany).toHaveBeenCalledTimes(1);
    expect(database.expensePayment.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PAID', dueDate: { gte: day(start), lt: day(end) },
        recurringExpense: { householdId: 'household', OR: [
          { scope: 'HOUSEHOLD' }, { scope: 'PERSONAL', personalPerson: { linkedUserId: 'viewer' } },
        ] },
      },
      select: { status: true, dueDate: true, actualAmountCents: true, recurringExpense: { select: { scope: true, personalPersonId: true } } },
    });
    expect(database.recurringExpense.findMany).toHaveBeenCalledTimes(1);
    expect(database.utilityInvoice.findMany).toHaveBeenCalledTimes(1);
    expect(database.variableExpenseMonth.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps an authenticated viewer in the payment loader authorization predicate', async () => {
    const database = { expensePayment: { findMany: vi.fn().mockResolvedValue([]) } };
    await loadMonthlyProgressPayments(database, 'household', day('2026-09-17'), 'viewer');
    expect(database.expensePayment.findMany.mock.calls[0][0].where.recurringExpense).not.toHaveProperty('isActive');
    expect(database.expensePayment.findMany.mock.calls[0][0].where.recurringExpense).not.toHaveProperty('archivedAt');
  });

  it('redacts private prepared aggregates even when no person is linked to the viewer', () => {
    const result = sanitizePlanningForViewer(planningRecord(), 'unlinked', people);
    expect(result.recommendedBudgetCents).toBe(1);
    expect(result.contributions.every((item) => item.personalExpenseCents === 0 && item.confirmedPersonalBalanceCents === null)).toBe(true);
  });

  it('legacy planning without a frozen identity never supplies private totals or balance fallback', async () => {
    const planning = planningRecord();
    delete planning.breakdown.personIdentitySnapshot;
    const result = await fixture({ planning }).read();
    expect(result.planning.personalHistoryRequiresConfirmation).toBe(true);
    expect(result.planning.contributions.find((row) => row.householdPersonId === 'own').confirmedPersonalBalanceCents).toBeNull();
    expect(result.cashCoverage.personal).toBeNull();
    expect(result.accountSummary.personal[0].balanceCents).toBe(0);
    expect(sanitizePlanningForViewer(planning, 'viewer').recommendedBudgetCents).toBe(1);
  });
});
