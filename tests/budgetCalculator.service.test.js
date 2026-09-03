import { describe, expect, it } from 'vitest';

import {
  calculateInvoiceStatistics,
  calculateMonthlyStandardBudget,
  calculateVariableStatistics,
  invoiceMonthlyEquivalentCents,
  monthlyEquivalentCents,
  resolveMarginBps,
  variableMonthTotalCents,
} from '../src/services/budgetCalculator.service.js';

const people = [
  { id: 'a', name: 'Persona A', contributionBps: 5_000, isActive: true },
  { id: 'b', name: 'Persona B', contributionBps: 5_000, isActive: true },
];

describe('budgetCalculator.service', () => {
  it('mensualiza todas las periodicidades conocidas', () => {
    expect(monthlyEquivalentCents({ amountCents: 1_200, frequency: 'MONTHLY' })).toBe(1_200);
    expect(monthlyEquivalentCents({ amountCents: 1_200, frequency: 'YEARLY' })).toBe(100);
    expect(monthlyEquivalentCents({ amountCents: 900, frequency: 'QUARTERLY' })).toBe(300);
    expect(
      monthlyEquivalentCents({
        amountCents: 1_000,
        frequency: 'CUSTOM_MONTHS',
        intervalMonths: 3,
      }),
    ).toBe(333);
    expect(monthlyEquivalentCents({ amountCents: 9_999, frequency: 'ONE_TIME' })).toBe(0);
  });

  it('normaliza facturas con duraciones distintas usando los días reales', () => {
    const short = {
      amountCents: 3_044,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-10',
    };
    const long = {
      amountCents: 6_088,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-20',
    };

    expect(invoiceMonthlyEquivalentCents(short)).toBe(9_266);
    expect(invoiceMonthlyEquivalentCents(long)).toBe(9_266);
    expect(calculateInvoiceStatistics([short, long]).historicalAverageCents).toBe(9_266);
  });

  it('el override 15 % prevalece sobre el margen general 10 %', () => {
    expect(
      resolveMarginBps({
        expenseMarginBps: 1_500,
        categoryMarginBps: null,
        householdMarginBps: 1_000,
      }),
    ).toBe(1_500);

    const budget = calculateMonthlyStandardBudget({
      householdMarginBps: 1_000,
      people,
      recurringExpenses: [
        {
          id: 'seguro',
          amountCents: 12_000,
          frequency: 'YEARLY',
          scope: 'HOUSEHOLD',
          safetyMarginOverrideBps: 1_500,
          isActive: true,
        },
      ],
    });

    expect(budget.householdBudgetCents).toBe(1_150);
  });

  it('mantiene separados los gastos personales del presupuesto común', () => {
    const budget = calculateMonthlyStandardBudget({
      people,
      recurringExpenses: [
        {
          id: 'comun',
          amountCents: 10_000,
          frequency: 'MONTHLY',
          scope: 'HOUSEHOLD',
          isActive: true,
        },
        {
          id: 'personal',
          amountCents: 3_500,
          frequency: 'MONTHLY',
          scope: 'PERSONAL',
          personalPersonId: 'a',
          isActive: true,
        },
      ],
    });

    expect(budget.householdBudgetCents).toBe(10_000);
    expect(budget.contributions).toEqual([
      expect.objectContaining({
        personId: 'a',
        standardHouseholdCents: 5_000,
        personalExpenseCents: 3_500,
        totalStandardCents: 8_500,
      }),
      expect.objectContaining({
        personId: 'b',
        standardHouseholdCents: 5_000,
        personalExpenseCents: 0,
        totalStandardCents: 5_000,
      }),
    ]);
  });

  it('conserva el nombre de cada partida en las líneas del presupuesto', () => {
    const budget = calculateMonthlyStandardBudget({
      people,
      recurringExpenses: [
        {
          id: 'alquiler',
          name: 'Alquiler',
          amountCents: 90_000,
          frequency: 'MONTHLY',
          scope: 'HOUSEHOLD',
          isActive: true,
        },
      ],
      invoiceGroups: [
        {
          categoryId: 'luz',
          category: { name: 'Electricidad' },
          invoices: [
            { amountCents: 10_000, periodStart: '2026-01-01', periodEnd: '2026-01-31' },
          ],
        },
      ],
      calculationDate: '2026-02-15',
      variableGroups: [
        {
          categoryId: 'compra',
          category: { name: 'Supermercado' },
          months: [
            {
              year: 2026,
              month: 1,
              entryMode: 'SUMMARY',
              summaryAmountCents: 20_000,
              isComplete: true,
            },
          ],
        },
      ],
    });

    expect(budget.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Alquiler', type: 'RECURRING' }),
        expect.objectContaining({ name: 'Electricidad', type: 'INVOICE' }),
        expect.objectContaining({ name: 'Supermercado', type: 'VARIABLE' }),
      ]),
    );
  });

  it('no suma resumen y detalles del mismo mes', () => {
    expect(
      variableMonthTotalCents({
        entryMode: 'SUMMARY',
        summaryAmountCents: 42_315,
        entries: [{ amountCents: 99_999 }],
      }),
    ).toBe(42_315);
  });

  it('ignora el mes actual y calcula la media de los meses anteriores', () => {
    const statistics = calculateVariableStatistics([
      {
        year: 2026,
        month: 6,
        entryMode: 'SUMMARY',
        summaryAmountCents: 30_000,
        isComplete: false,
      },
      {
        year: 2026,
        month: 7,
        entryMode: 'SUMMARY',
        summaryAmountCents: 40_000,
      },
      {
        year: 2026,
        month: 8,
        entryMode: 'SUMMARY',
        summaryAmountCents: 99_000,
      },
    ], { calculationDate: '2026-08-15' });

    expect(statistics.averages.months3).toBe(35_000);
    expect(statistics.availableMonths.months3).toBe(2);
    expect(statistics.latestMonth).toBe('2026-07');
  });
});
