import { describe, expect, it } from 'vitest';

import {
  dashboardDuePayments,
  planningMatchesBudget,
  rebasePlanningToBudget,
} from '../src/modules/finance/finance.service.js';

describe('dashboardDuePayments', () => {
  it('puts overdue payments first and excludes dates more than five days ahead', () => {
    const payments = dashboardDuePayments(
      [
        {
          id: 'late',
          name: 'Alquiler',
          amountCents: 90_000,
          nextDueDate: '2026-08-20',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'today',
          name: 'Internet',
          amountCents: 5_000,
          nextDueDate: '2026-08-26',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'near',
          name: 'Luz',
          amountCents: 8_000,
          nextDueDate: '2026-08-31',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'far',
          name: 'Seguro',
          amountCents: 12_000,
          nextDueDate: '2026-09-26',
          scope: 'HOUSEHOLD',
        },
      ],
      '2026-08-26',
    );

    expect(payments.map((payment) => payment.expenseId)).toEqual(['late', 'today', 'near']);
  });
});

describe('planningMatchesBudget', () => {
  const budget = {
    contributions: [
      { personId: 'pablo', contributionBps: 2_000 },
      { personId: 'natalia', contributionBps: 8_000 },
    ],
  };

  it('detecta que una planificación guardada usa el reparto actual', () => {
    expect(
      planningMatchesBudget(
        {
          contributions: [
            { householdPersonId: 'natalia', contributionBps: 8_000 },
            { householdPersonId: 'pablo', contributionBps: 2_000 },
          ],
        },
        budget,
      ),
    ).toBe(true);
  });

  it('invalida la planificación cuando cambia el porcentaje', () => {
    expect(
      planningMatchesBudget(
        {
          contributions: [
            { householdPersonId: 'natalia', contributionBps: 5_000 },
            { householdPersonId: 'pablo', contributionBps: 5_000 },
          ],
        },
        budget,
      ),
    ).toBe(false);
  });

  it('recalcula el reparto manteniendo los saldos ya confirmados', () => {
    const rebased = rebasePlanningToBudget(
      {
        confirmedBalanceCents: 80_000,
        contributions: [
          {
            confirmedPersonalBalanceCents: 120_000,
            contributionBps: 5_000,
            householdPersonId: 'pablo',
            temporaryAdjustmentCents: 0,
          },
          {
            confirmedPersonalBalanceCents: 90_000,
            contributionBps: 5_000,
            householdPersonId: 'natalia',
            temporaryAdjustmentCents: 0,
          },
        ],
      },
      {
        householdBudgetCents: 100_000,
        recommendedBudgetCents: 100_000,
        contributions: [
          {
            contributionBps: 2_000,
            personId: 'pablo',
            personName: 'Pablo',
            personalExpenseCents: 0,
            standardHouseholdCents: 20_000,
            totalStandardCents: 20_000,
          },
          {
            contributionBps: 8_000,
            personId: 'natalia',
            personName: 'Natalia',
            personalExpenseCents: 0,
            standardHouseholdCents: 80_000,
            totalStandardCents: 80_000,
          },
        ],
      },
    );

    expect(rebased.contributions).toEqual([
      expect.objectContaining({
        confirmedPersonalBalanceCents: 120_000,
        contributionBps: 2_000,
        standardHouseholdCents: 20_000,
      }),
      expect.objectContaining({
        confirmedPersonalBalanceCents: 90_000,
        contributionBps: 8_000,
        standardHouseholdCents: 80_000,
      }),
    ]);
  });
});
