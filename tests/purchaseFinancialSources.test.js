import { describe, expect, it } from 'vitest';
import { buildPurchaseFinancialSources, loadPurchaseFinancialSources, upcomingPurchasePayments } from '../src/modules/finance/purchaseFinancialSources.js';
import { createPurchaseAllocationSnapshot } from '../src/modules/purchases/purchaseAllocation.js';
import { calculateMonthlyStandardBudget } from '../src/services/budgetCalculator.service.js';
import { calculateMonthlySpendingProgress } from '../src/services/monthlySpendingProgress.service.js';
import { buildCalendar } from '../src/services/calendar.service.js';
import { planningMatchesBudget } from '../src/modules/finance/finance.service.js';

const people = [{ id: 'p1', name: 'Pablo', linkedUserId: 'u1', contributionBps: 6000 }, { id: 'p2', name: 'Natalia', linkedUserId: 'u2', contributionBps: 4000 }];
const purchase = (overrides = {}) => ({ id: 'purchase', householdId: 'household', purchaseDate: '2026-09-17', merchant: 'Tienda', items: [{ name: 'Móvil' }], ownershipType: 'HOUSEHOLD', paymentMethod: 'FINANCED', financing: { id: 'financing', downPaymentCents: 0, installmentCount: 2, installments: [{ id: 'i1', sequence: 1, dueDate: '2026-09-30', expectedAmountCents: 1000, status: 'PLANNED' }, { id: 'i2', sequence: 2, dueDate: '2026-10-31', expectedAmountCents: 1000, status: 'PLANNED' }] }, ...overrides });
const range = { from: '2026-09-01', to: '2026-09-30', actorUserId: 'u1' };
const sources = (value, options = {}) => buildPurchaseFinancialSources([value], { ...range, ...options });
const budget = (items, calculationDate = '2026-09-17') => calculateMonthlyStandardBudget({ people, householdMarginBps: 5000, calculationDate, purchaseSources: items });

describe('one canonical purchase source for finance', () => {
  it('does not infer payment for legacy upfront and does not budget full financed purchase price', () => {
    expect(sources(purchase({ paymentMethod: 'UPFRONT', totalCents: 120_000 }))).toEqual([]);
    expect(budget(sources(purchase({ totalCents: 120_000 }))).householdBudgetCents).toBe(1000);
  });
  it('uses paidAmount rather than editable purchase price, with no margin', () => {
    const p = purchase({ paymentMethod: 'UPFRONT', totalCents: 9999, paymentDate: '2026-09-17', paidAmountCents: 9000 });
    p.paymentAllocationSnapshot = createPurchaseAllocationSnapshot(p);
    expect(budget(sources(p)).lines[0]).toMatchObject({ sourceType: 'PURCHASE_UPFRONT', amountCents: 9000, effectiveMarginBps: 0 });
  });
  it('only requested calendar month contributes even when loaded sources span a year', () => {
    const loaded = sources(purchase(), { to: '2027-08-31' });
    expect(loaded).toHaveLength(2);
    expect(budget(loaded).householdBudgetCents).toBe(1000);
    expect(budget(loaded, '2026-10-01').householdBudgetCents).toBe(1000);
    expect(budget(loaded, '2026-11-01').householdBudgetCents).toBe(0);
  });
  it('excludes cancelled installments from budget, progress and Calendar', () => {
    const p = purchase(); p.financing.installments[0].status = 'CANCELLED';
    expect(sources(p)).toHaveLength(0);
  });
  it('pending downpayment is budget only until explicit paid date, which sets its month', () => {
    const p = purchase(); p.financing.downPaymentCents = 20_000;
    expect(sources(p)[0]).toMatchObject({ sourceType: 'PURCHASE_DOWN_PAYMENT', status: 'PLANNED', actualAmountCents: null });
    p.financing.downPaymentPaidAt = '2026-08-31'; p.financing.downPaymentAllocationSnapshot = createPurchaseAllocationSnapshot(p);
    expect(sources(p).map((item) => item.sourceType)).toEqual(['PURCHASE_INSTALLMENT']);
    expect(sources(p, { from: '2026-08-01', to: '2026-08-31' })[0]).toMatchObject({ budgetDate: '2026-08-31', actualAmountCents: 20_000 });
  });
  it('allocates expected and actual separately with exact stable cent totals', () => {
    const p = purchase({ ownershipType: 'SPLIT', shares: people.map((person, index) => ({ householdPersonId: person.id, shareBps: [6000, 4000][index], householdPerson: person })) });
    Object.assign(p.financing.installments[0], { status: 'PAID', paidAt: '2026-09-17', actualAmountCents: 1001, paymentAllocationSnapshot: createPurchaseAllocationSnapshot(p) });
    const all = sources(p, { actorUserId: undefined });
    expect(all.map((item) => item.expectedAmountCents)).toEqual([600, 400]);
    expect(all.reduce((sum, row) => sum + row.actualAmountCents, 0)).toBe(1001);
    expect(sources(p)).toHaveLength(1);
    expect(JSON.stringify(sources(p))).not.toContain('u2');
    expect(JSON.stringify(sources(p))).not.toContain('p2');
  });
  it('requires a valid historical snapshot and matching household instead of silently using current ownership', () => {
    const p = purchase(); Object.assign(p.financing.installments[0], { status: 'PAID', paidAt: '2026-09-17', actualAmountCents: 1000 });
    expect(() => sources(p)).toThrow(/histórico/);
    p.financing.installments[0].paymentAllocationSnapshot = { ...createPurchaseAllocationSnapshot(p), householdId: 'other' };
    expect(() => sources(p)).toThrow(/hogar/);
  });
  it('keeps archived real spending without current labels or pending obligations', () => {
    const p = purchase(); Object.assign(p.financing.installments[0], { status: 'PAID', paidAt: '2026-09-17', actualAmountCents: 1000, paymentAllocationSnapshot: createPurchaseAllocationSnapshot(p) });
    p.archivedAt = '2026-09-17'; p.items[0].name = 'PRIVATE_CURRENT_NAME';
    const loaded = sources(p, { to: '2026-12-31' });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ canAccessPurchase: false, canEditPayment: false, name: 'Pago histórico de compra · Cuota 1/2' });
    expect(JSON.stringify(loaded)).not.toContain('PRIVATE_CURRENT_NAME');
  });
  it('cash used is paidAt month; expected budget remains due month after early payment', () => {
    const p = purchase(); Object.assign(p.financing.installments[1], { status: 'PAID', paidAt: '2026-09-17', actualAmountCents: 1100, paymentAllocationSnapshot: createPurchaseAllocationSnapshot(p) });
    const loaded = sources(p);
    const progress = calculateMonthlySpendingProgress({ calculationDate: '2026-09-17', commonBudgetCents: budget(loaded).householdBudgetCents, purchaseSources: loaded, commonBalanceCents: 0 });
    expect(progress.monthlyProgress.common).toMatchObject({ budgetCents: 1000, usedCents: 1100, overBudgetCents: 100 });
  });
  it('Calendar preserves source identity and only the global first pending action', () => {
    const p = purchase();
    const loaded = sources(p, { from: '2026-10-01', to: '2026-10-31', firstPendingByFinancing: new Map([['financing', 'i1']]) });
    const result = buildCalendar({ recurringExpenses: [], purchaseSources: loaded, today: '2026-09-17', anchorDate: '2026-10-01', view: 'MONTH' });
    expect(result.events[0]).toMatchObject({ sourceType: 'PURCHASE_INSTALLMENT', status: 'UPCOMING', sequence: 2, canRegisterPayment: false, expectedAmountCents: 1000 });
    expect(result.events[0]).not.toHaveProperty('expenseId');
  });
  it('loader respects an explicit global no-pending result instead of authorizing a stale loaded installment', async () => {
    const database = {
      purchase: { findMany: async () => [purchase()] },
      // A concurrent payment can finish after the first query loads its rows.
      purchaseFinancing: { findMany: async () => [{ id: 'financing', installments: [] }] },
      householdPerson: { findMany: async () => people },
    };
    const loaded = await loadPurchaseFinancialSources(database, { householdId: 'household', ...range });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ installmentId: 'i1', status: 'PLANNED', canRegisterPayment: false });
  });
  it('upcoming can include overdue pending only, never real paid history', () => {
    const loaded = sources(purchase());
    expect(upcomingPurchasePayments(loaded, '2026-10-01')).toEqual([]);
    expect(upcomingPurchasePayments(loaded, '2026-10-01', { includeOverdue: true })).toHaveLength(1);
  });
  it('planning detects changed amounts even with unchanged people and percentages', () => {
    const previous = { contributions: [{ householdPersonId: 'p1', contributionBps: 10_000, standardHouseholdCents: 0, personalExpenseCents: 0 }] };
    const current = { contributions: [{ personId: 'p1', contributionBps: 10_000, standardHouseholdCents: 1000, personalExpenseCents: 0 }] };
    expect(planningMatchesBudget(previous, current)).toBe(false);
  });
});
