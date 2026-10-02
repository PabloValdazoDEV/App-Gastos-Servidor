import { describe, expect, it } from 'vitest';

import { calculateMonthlyOverview } from '../src/services/monthlyOverview.service.js';

const expense = (overrides = {}) => ({
  id: 'rent', name: 'Alquiler', scope: 'HOUSEHOLD', amountCents: 60000,
  nextDueDate: '2026-09-01', frequency: 'MONTHLY', ...overrides,
});
const variable = (overrides = {}) => ({
  id: 'groceries', scope: 'HOUSEHOLD', category: { id: 'food', name: 'Supermercado' },
  year: 2026, month: 9, entryMode: 'DETAIL', entries: [
    { id: 'shop', merchant: 'Compra', spentOn: '2026-09-03', amountCents: 20000, paidAt: '2026-09-03' },
  ], ...overrides,
});
const forecast = (overrides = {}) => ({
  id: 'food:HOUSEHOLD', name: 'Supermercado', type: 'VARIABLE', scope: 'HOUSEHOLD',
  category: { id: 'food', name: 'Supermercado' }, baseCents: 40000, amountCents: 44000,
  ...overrides,
});
const read = (overrides = {}) => calculateMonthlyOverview({
  calculationDate: '2026-09-17', commonBalanceCents: 200000,
  commonBalanceSource: 'ACCOUNTS', viewerPersonId: 'me', ...overrides,
});

describe('Monthly account overview', () => {
  it('makes the month reconcile and never subtracts confirmed payments twice from today’s balance', () => {
    const result = read({ recurringExpenses: [expense()], variableMonths: [variable()], budgetLines: [forecast()] });
    expect(result.common).toMatchObject({
      balanceCents: 200000, expectedCents: 104000, paidCents: 20000,
      unconfirmedCents: 60000, estimatedCents: 24000, remainingCents: 84000, projectedBalanceCents: 116000,
    });
    expect(result.common.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(104000);
    expect(result.common.lines.find((line) => line.status === 'ESTIMATED')).toMatchObject({ basisTotalCents: 44000, recordedCents: 20000, allowanceCents: 4000 });
  });

  it('counts an annual bill in full only in its due month, not its monthly saving contribution', () => {
    const inputs = { recurringExpenses: [expense({ frequency: 'YEARLY', amountCents: 120000 })], budgetLines: [forecast({ type: 'RECURRING', amountCents: 11000 })] };
    expect(read(inputs).common.expectedCents).toBe(120000);
    expect(read({ ...inputs, calculationDate: '2026-10-01' }).common.expectedCents).toBe(0);
  });

  it('replaces a recurring forecast with its actual paid amount, and excludes skipped occurrences', () => {
    const recurring = expense();
    const payment = { id: 'paid', recurringExpenseId: recurring.id, dueDate: '2026-09-01', paymentDate: '2026-08-31', status: 'PAID', actualAmountCents: 55000, recurringExpense: recurring };
    const result = read({ recurringExpenses: [recurring], payments: [payment] }).common;
    expect(result).toMatchObject({ expectedCents: 55000, paidCents: 55000, remainingCents: 0, projectedBalanceCents: 200000 });
    expect(read({ recurringExpenses: [recurring], payments: [{ ...payment, status: 'SKIPPED', actualAmountCents: null }] }).common.expectedCents).toBe(0);
    expect(read({ payments: [{ ...payment, recurringExpense: { ...recurring, archivedAt: '2026-09-02' } }] }).common.paidCents).toBe(55000);
  });

  it('treats registered invoices, one-offs and variables as unconfirmed until paidAt exists', () => {
    const inputs = {
      variableMonths: [variable({ entries: [{ id: 'shop', spentOn: '2026-09-03', amountCents: 20000 }] })],
      invoices: [{ id: 'bill', scope: 'HOUSEHOLD', invoiceDate: '2026-08-31', chargeDate: '2026-09-15', amountCents: 7000 }],
      oneTimeExpenses: [{ id: 'desk', name: 'Mesa', scope: 'HOUSEHOLD', expenseDate: '2026-09-20', amountCents: 30000 }],
    };
    expect(read(inputs).common).toMatchObject({ paidCents: 0, unconfirmedCents: 57000 });
    inputs.variableMonths[0].entries[0].paidAt = '2026-09-30';
    inputs.invoices[0].paidAt = '2026-09-30';
    inputs.oneTimeExpenses[0].paidAt = '2026-09-30';
    expect(read(inputs).common).toMatchObject({ paidCents: 57000, unconfirmedCents: 0 });
  });

  it('uses a supplied invoice or monthly summary in place of an estimate, even if below the average', () => {
    const result = read({
      budgetLines: [forecast(), forecast({ id: 'bill', type: 'INVOICE' })],
      variableMonths: [variable({ entryMode: 'SUMMARY', summaryAmountCents: 10000 })],
      invoices: [{ id: 'bill', scope: 'HOUSEHOLD', category: { id: 'food' }, invoiceDate: '2026-09-04', amountCents: 5000 }],
    }).common;
    expect(result).toMatchObject({ expectedCents: 15000, unconfirmedCents: 15000, estimatedCents: 0 });
  });

  it('does not double count estimates or hide overspending when registered variables exceed the forecast', () => {
    const result = read({ commonBalanceCents: 0, budgetLines: [forecast()], variableMonths: [variable({ entries: [{ id: 'overspend', spentOn: '2026-09-09', amountCents: 50000 }] })] }).common;
    expect(result).toMatchObject({ expectedCents: 50000, estimatedCents: 0, projectedBalanceCents: -50000 });
  });

  it('keeps personal amounts out of common totals and cannot infer another person’s balance', () => {
    const inputs = { recurringExpenses: [expense({ scope: 'PERSONAL', personalPersonId: 'me' }), expense({ id: 'secret', scope: 'PERSONAL', personalPersonId: 'other', amountCents: 987654 })] };
    const result = read(inputs);
    expect(result.common.expectedCents).toBe(0);
    expect(result.personal).toMatchObject({ expectedCents: 60000, balanceCents: null, projectedBalanceCents: null });
    expect(JSON.stringify(result)).not.toContain('987654');
    expect(read({ ...inputs, viewerPersonId: null }).personal).toBeNull();
  });

  it('counts only the visible purchase share and keeps already paid installments out of pending', () => {
    const result = read({ purchaseSources: [
      { id: 'purchase:personal', sourceType: 'PURCHASE_INSTALLMENT', scope: 'PERSONAL', personalPersonId: 'me', name: 'Mi parte', dueDate: '2026-09-05', status: 'PAID', expectedAmountCents: 4000, actualAmountCents: 3600, paidAt: '2026-08-30' },
      { id: 'purchase:common', sourceType: 'PURCHASE_INSTALLMENT', scope: 'HOUSEHOLD', name: 'Cuota', dueDate: '2026-09-30', status: 'PLANNED', expectedAmountCents: 6000 },
      { id: 'next', sourceType: 'PURCHASE_INSTALLMENT', scope: 'HOUSEHOLD', name: 'Próxima', dueDate: '2026-10-30', status: 'PLANNED', expectedAmountCents: 9999 },
    ] });
    expect(result.common).toMatchObject({ expectedCents: 6000, remainingCents: 6000 });
    expect(result.personal).toMatchObject({ expectedCents: 3600, paidCents: 3600, remainingCents: 0 });
  });

  it('uses exact calendar-month boundaries across a year change', () => {
    expect(read({ calculationDate: '2026-12-31' })).toMatchObject({ rangeStart: '2026-12-01', rangeEnd: '2026-12-31' });
    expect(read({ calculationDate: '2027-02-01' })).toMatchObject({ rangeStart: '2027-02-01', rangeEnd: '2027-02-28' });
  });
});
