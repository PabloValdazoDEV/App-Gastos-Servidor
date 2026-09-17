import { describe, expect, it } from 'vitest';
import {
  calculateInvoiceStatistics, calculateVariableStatistics, calculateMonthlyStandardBudget,
} from '../src/services/budgetCalculator.service.js';
import { budgetMarginLookup } from '../src/modules/finance/budgetMarginPreference.service.js';
import { createOneTimeExpenseSchema, updateOneTimeExpenseSchema } from '../src/modules/finance/finance.schemas.js';

const people = [{ id: 'a', contributionBps: 10_000, isActive: true }];
const invoices = [
  { amountCents: 10_000, periodStart: '2026-04-01', periodEnd: '2026-04-30' },
  { amountCents: 12_000, periodStart: '2026-06-01', periodEnd: '2026-06-30' },
  { amountCents: 11_000, periodStart: '2026-09-01', periodEnd: '2026-09-30' },
];
const months = [10_000, 12_000, 11_000].map((amount, index) => ({
  year: 2026, month: index + 6, entryMode: 'SUMMARY', summaryAmountCents: amount,
}));

describe.each([
  ['facturas', (options) => calculateInvoiceStatistics(invoices, options)],
  ['variables', (options) => calculateVariableStatistics(months, { calculationDate: '2026-09-17', ...options })],
])('margen presupuestario: %s', (_name, statistics) => {
  it.each([undefined, false])('sin preferencia o desactivado (%s) mantiene base y margen cero', (applySafetyMargin) => {
    const result = statistics({ householdMarginBps: 1_000, categoryMarginBps: 1_500, applySafetyMargin });
    expect(result).toMatchObject({ applySafetyMargin: false, effectiveMarginBps: 0, marginSource: 'NONE' });
    expect(result.recommendedCents).toBe(result.baseCents);
  });

  it.each([
    [null, 1_000, 1_000, 'HOUSEHOLD'],
    [1_500, 1_000, 1_500, 'CATEGORY'],
    [0, 1_000, 0, 'CATEGORY'],
    [null, null, 0, 'NONE'],
  ])('activado resuelve categoría %s / hogar %s sin tocar medias', (categoryMarginBps, householdMarginBps, expected, source) => {
    const options = { categoryMarginBps, householdMarginBps };
    const before = statistics(options);
    const active = statistics({ ...options, applySafetyMargin: true });
    const after = statistics({ ...options, applySafetyMargin: false });
    expect(active).toMatchObject({ effectiveMarginBps: expected, marginSource: source, availableMarginBps: expected });
    expect(active.historicalAverageCents).toBe(before.historicalAverageCents);
    expect(active.averages).toEqual(before.averages);
    expect(active.baseCents).toBe(before.baseCents);
    expect(active.recommendedCents).toBe(Math.round(before.baseCents * (10_000 + expected) / 10_000));
    expect(after).toEqual(before);
  });
});

describe('líneas y preferencias de margen', () => {
  it('no contamina la media 110 € de variables con su recomendado de 121 €', () => {
    const result = calculateVariableStatistics(months, { calculationDate: '2026-09-17', householdMarginBps: 1_000, applySafetyMargin: true });
    expect(result).toMatchObject({ baseCents: 11_000, historicalAverageCents: 11_000, recommendedCents: 12_100 });
    expect(result.averages).toEqual({ months3: 11_000, months6: 11_000, months12: 11_000 });
  });

  it('los grupos sin histórico no inventan importes aunque se active el margen', () => {
    for (const result of [calculateInvoiceStatistics([], { applySafetyMargin: true, householdMarginBps: 1_000 }), calculateVariableStatistics([], { applySafetyMargin: true, householdMarginBps: 1_000 })]) {
      expect(result).toMatchObject({ baseCents: null, recommendedCents: null, effectiveMarginBps: 1_000 });
    }
  });

  it('aísla tipo, categoría, común y dos personas; ausencia = false', () => {
    const common = { categoryId: 'luz', scope: 'HOUSEHOLD' };
    const personalA = { categoryId: 'luz', scope: 'PERSONAL', personalPersonId: 'a' };
    const personalB = { ...personalA, personalPersonId: 'b' };
    const applies = budgetMarginLookup([
      { ...common, expenseType: 'INVOICE', applySafetyMargin: true },
      { ...personalA, expenseType: 'INVOICE', applySafetyMargin: false },
      { ...personalB, expenseType: 'INVOICE', applySafetyMargin: true },
      { ...personalA, expenseType: 'VARIABLE', applySafetyMargin: true },
    ]);
    expect([common, personalA, personalB].map((group) => applies('INVOICE', group))).toEqual([true, false, true]);
    expect([common, personalA, personalB].map((group) => applies('VARIABLE', group))).toEqual([false, true, false]);
    expect(applies('INVOICE', { ...common, categoryId: 'agua' })).toBe(false);
  });

  it.each([false, true])('las líneas de facturas/variables usan la preferencia %s y conservan la base', (enabled) => {
    const budget = calculateMonthlyStandardBudget({
      people, calculationDate: '2026-10-01', householdMarginBps: 1_000,
      invoiceGroups: [{ categoryId: 'luz', invoices, applySafetyMargin: enabled }],
      variableGroups: [{ categoryId: 'luz', months, applySafetyMargin: enabled }],
    });
    expect(budget.lines).toHaveLength(2);
    for (const line of budget.lines) {
      expect(line.effectiveMarginBps).toBe(enabled ? 1_000 : 0);
      expect(line.amountCents).toBe(Math.round(line.baseCents * (enabled ? 1.1 : 1)));
    }
  });

  it.each([
    [undefined, 1_500, 0], [false, 1_500, 0], [true, 1_500, 1_500], [true, null, 1_000], [true, 0, 0],
  ])('puntual: activación %s categoría %s aplica %s bps', (applySafetyMargin, categoryMargin, expected) => {
    const budget = calculateMonthlyStandardBudget({
      people, calculationDate: '2026-09-17', householdMarginBps: 1_000,
      oneTimeExpenses: [{ id: 'gasto', amountCents: 10_000, expenseDate: '2026-09-01', applySafetyMargin, category: { safetyMarginBps: categoryMargin } }],
    });
    expect(budget.lines[0]).toMatchObject({ baseCents: 10_000, effectiveMarginBps: expected, amountCents: 10_000 + expected });
  });

  it('recurrentes conservan herencia general/categoría, override y cero explícito', () => {
    const budget = calculateMonthlyStandardBudget({
      people, householdMarginBps: 1_000,
      recurringExpenses: [
        {}, { category: { safetyMarginBps: 1_500 } },
        { safetyMarginOverrideBps: 2_000, category: { safetyMarginBps: 1_500 } },
        { safetyMarginOverrideBps: 0, category: { safetyMarginBps: 1_500 } },
      ].map((item, index) => ({ id: String(index), scope: 'HOUSEHOLD', frequency: 'MONTHLY', amountCents: 10_000, ...item })),
    });
    expect(budget.lines.map((line) => line.effectiveMarginBps)).toEqual([1_000, 1_500, 2_000, 0]);
    expect(budget.lines.map((line) => line.amountCents)).toEqual([11_000, 11_500, 12_000, 10_000]);
  });

  it('el schema crea puntuales sin margen y PATCH no resetea un valor omitido', () => {
    const created = createOneTimeExpenseSchema.parse({ categoryId: '10000000-0000-4000-8000-000000000001', name: 'Puntual', amountCents: 100, expenseDate: '2026-09-17' });
    expect(created.applySafetyMargin).toBe(false);
    expect(updateOneTimeExpenseSchema.parse({ name: 'Otro nombre' })).not.toHaveProperty('applySafetyMargin');
    expect(updateOneTimeExpenseSchema.parse({ applySafetyMargin: false })).toEqual({ applySafetyMargin: false });
    expect(() => updateOneTimeExpenseSchema.parse({})).toThrow();
  });
});
