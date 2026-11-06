import { describe, expect, it } from 'vitest';

import {
  calculateSimulation,
  calculateTheoreticalReserve,
  distributeTemporaryAdjustment,
  previewRecoveryPlan,
  recoveryAdjustmentForMonth,
} from '../src/services/planningCalculator.service.js';

const standardBudget = { householdBudgetCents: 108_142 };
const annualExpense = {
  id: 'seguro',
  name: 'Seguro',
  amountCents: 120_000,
  frequency: 'YEARLY',
  scope: 'HOUSEHOLD',
  startDate: '2025-12-31',
  nextDueDate: '2026-12-31',
  isActive: true,
};

describe('planningCalculator.service', () => {
  it('cambiar simulationDate no cambia monthlyStandardBudget', () => {
    const august = calculateSimulation({
      standardBudget,
      recurringExpenses: [annualExpense],
      simulationDate: '2026-08-29',
      relevantAvailableBalanceCents: 50_000,
    });
    const september = calculateSimulation({
      standardBudget,
      recurringExpenses: [annualExpense],
      simulationDate: '2026-09-29',
      relevantAvailableBalanceCents: 50_000,
    });

    expect(august.monthlyStandardBudgetCents).toBe(108_142);
    expect(september.monthlyStandardBudgetCents).toBe(108_142);
  });

  it('cambiar simulationDate sí cambia theoreticalReserve', () => {
    const august = calculateTheoreticalReserve([annualExpense], '2026-08-29');
    const september = calculateTheoreticalReserve([annualExpense], '2026-09-29');

    expect(september.theoreticalReserveCents).toBeGreaterThan(
      august.theoreticalReserveCents,
    );
  });

  it('calcula los tres modos de recuperación', () => {
    expect(
      previewRecoveryPlan({
        deficitCents: 50_000,
        mode: 'TARGET_MONTHS',
        targetMonths: 5,
      }),
    ).toMatchObject({ monthlyAdjustmentCents: 10_000, estimatedMonths: 5 });

    expect(
      previewRecoveryPlan({
        deficitCents: 50_000,
        mode: 'MAX_MONTHLY',
        maximumMonthlyCents: 6_000,
      }),
    ).toMatchObject({ monthlyAdjustmentCents: 6_000, estimatedMonths: 9 });

    expect(
      previewRecoveryPlan({
        deficitCents: 12_000,
        mode: 'RECOMMENDED',
        relevantAvailableBalanceCents: 0,
        upcomingPayments: [],
      }),
    ).toMatchObject({ monthlyAdjustmentCents: 1_000, estimatedMonths: 12 });
  });

  it('recomienda según la aportación estándar y los meses reales hasta el pago', () => {
    const common = {
      deficitCents: 120_000,
      mode: 'RECOMMENDED',
      relevantAvailableBalanceCents: 0,
      standardMonthlyBudgetCents: 10_000,
      startsOn: '2026-01-15',
    };
    const urgent = previewRecoveryPlan({
      ...common,
      upcomingPayments: [
        {
          amountCents: 60_000,
          dueDate: '2026-02-20',
          scope: 'HOUSEHOLD',
        },
      ],
    });
    const later = previewRecoveryPlan({
      ...common,
      upcomingPayments: [
        {
          amountCents: 60_000,
          dueDate: '2026-06-20',
          scope: 'HOUSEHOLD',
        },
      ],
    });

    expect(urgent).toMatchObject({
      monthlyAdjustmentCents: 20_000,
      estimatedMonths: 6,
      recommendation: {
        standardMonthlyBudgetCents: 10_000,
        cashFlowMinimumCents: 20_000,
        limitingDueDate: '2026-02-20',
        limitingMonthsAvailable: 2,
      },
    });
    expect(later).toMatchObject({
      monthlyAdjustmentCents: 10_000,
      estimatedMonths: 12,
      recommendation: {
        cashFlowMinimumCents: 0,
        limitingDueDate: null,
      },
    });
  });

  it('usa la aportación estándar al evaluar el flujo acumulado', () => {
    const input = {
      deficitCents: 120_000,
      mode: 'RECOMMENDED',
      relevantAvailableBalanceCents: 0,
      startsOn: '2026-01-01',
      upcomingPayments: [
        {
          amountCents: 100_000,
          dueDate: '2026-04-01',
          scope: 'HOUSEHOLD',
        },
      ],
    };

    const withoutStandard = previewRecoveryPlan({
      ...input,
      standardMonthlyBudgetCents: 0,
    });
    const withStandard = previewRecoveryPlan({
      ...input,
      standardMonthlyBudgetCents: 20_000,
    });

    expect(withoutStandard.recommendation.cashFlowMinimumCents).toBe(25_000);
    expect(withStandard.recommendation.cashFlowMinimumCents).toBe(5_000);
    expect(withStandard.monthlyAdjustmentCents).toBe(10_000);
  });

  it('reparte el ajuste temporal sin convertirlo en estándar', () => {
    expect(
      distributeTemporaryAdjustment(6_001, [
        { id: 'a', contributionBps: 5_000 },
        { id: 'b', contributionBps: 5_000 },
      ]),
    ).toEqual([
      { personId: 'a', temporaryAdjustmentCents: 3_001 },
      { personId: 'b', temporaryAdjustmentCents: 3_000 },
    ]);
  });
});

describe('recoveryAdjustmentForMonth', () => {
  const d = (value) => new Date(`${value}T00:00:00.000Z`);
  const plan = {
    status: 'ACTIVE',
    startsOn: d('2026-11-06'),
    monthlyAdjustmentCents: 60_000,
    remainingDeficitCents: 60_000,
  };

  it('aplica el ajuste en el mes de inicio', () => {
    expect(recoveryAdjustmentForMonth(plan, d('2026-11-01'))).toBe(60_000);
  });

  it('no aplica nada antes del mes de inicio', () => {
    expect(recoveryAdjustmentForMonth(plan, d('2026-10-01'))).toBe(0);
  });

  it('no aplica nada cuando ya no queda déficit (el plan no se repite cada mes)', () => {
    expect(recoveryAdjustmentForMonth({ ...plan, remainingDeficitCents: 0 }, d('2026-12-01'))).toBe(0);
  });

  it('en el último mes solo pide lo que falta', () => {
    const capped = { ...plan, monthlyAdjustmentCents: 30_000, remainingDeficitCents: 10_000 };
    expect(recoveryAdjustmentForMonth(capped, d('2027-02-01'))).toBe(10_000);
  });

  it('ignora planes cancelados o completados', () => {
    expect(recoveryAdjustmentForMonth({ ...plan, status: 'COMPLETED' }, d('2026-11-01'))).toBe(0);
    expect(recoveryAdjustmentForMonth(null, d('2026-11-01'))).toBe(0);
  });
});
