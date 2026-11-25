import { describe, expect, it } from 'vitest';

import { buildFundingBasis, calculateFundingShortfall } from '../src/services/fundingCheck.service.js';
import { pendingDueDates } from '../src/modules/finance/finance.service.js';

const reserveLine = (overrides) => ({
  expenseId: 'insurance', name: 'Seguro coche', dueDate: '2027-03-02', overdue: false,
  reserveCents: 40_000, targetAmountCents: 60_000, ...overrides,
});

describe('buildFundingBasis', () => {
  const base = {
    calculationDate: '2026-11-01',
    pendingThisMonthCents: 106_700,
    plannedContributionCents: 71_600,
    pendingDueDatesFor: pendingDueDates,
    contributions: [{ personId: 'a', personName: 'A', contributionBps: 5_000, extra: true }],
  };

  it('solo reserva para pagos posteriores a este mes: un anual que vence este mes ya está en lo pendiente', () => {
    const basis = buildFundingBasis({
      ...base,
      reserveLines: [
        reserveLine({ expenseId: 'later', dueDate: '2027-03-02', reserveCents: 40_000 }),
        reserveLine({ expenseId: 'this-month', dueDate: '2026-11-20', reserveCents: 59_000 }),
        reserveLine({ expenseId: 'overdue', dueDate: '2026-10-02', reserveCents: 60_000, overdue: true }),
      ],
    });
    expect(basis.reserveForLaterCents).toBe(40_000);
    expect(basis.reserveForLaterLines.map((line) => line.expenseId)).toEqual(['later']);
    expect(basis.contributions).toEqual([{ personId: 'a', personName: 'A', contributionBps: 5_000 }]);
  });

  it('cuenta los atrasados comunes de meses anteriores, no los personales ni los de este mes', () => {
    const basis = buildFundingBasis({
      ...base,
      reserveLines: [],
      recurringExpenses: [
        { id: 'srv', scope: 'HOUSEHOLD', amountCents: 1_800, nextDueDate: '2026-09-05', frequency: 'MONTHLY', usualDayOfMonth: 5 },
        { id: 'gym', scope: 'PERSONAL', amountCents: 3_500, nextDueDate: '2026-09-03', frequency: 'MONTHLY', usualDayOfMonth: 3 },
        { id: 'net', scope: 'HOUSEHOLD', amountCents: 4_000, nextDueDate: '2026-11-01', frequency: 'MONTHLY', usualDayOfMonth: 1 },
        { id: 'old', scope: 'HOUSEHOLD', amountCents: 9_900, nextDueDate: '2026-08-01', frequency: 'MONTHLY', archivedAt: '2026-08-15' },
      ],
    });
    // Servidor: 5 sept y 5 oct sin pagar (el de noviembre es de este mes).
    expect(basis.overdueCents).toBe(3_600);
  });
});

describe('calculateFundingShortfall', () => {
  const basis = {
    pendingThisMonthCents: 106_700, overdueCents: 5_400, reserveForLaterCents: 62_600, plannedContributionCents: 71_600,
  };

  it('si aún no se ha hecho la aportación, la suma al saldo antes de decir que falta dinero', () => {
    expect(calculateFundingShortfall(basis, { balanceCents: 90_000, contributionDone: false })).toEqual({
      balanceCents: 90_000,
      pendingContributionCents: 71_600,
      availableCents: 161_600,
      neededCents: 174_700,
      shortfallCents: 13_100,
      surplusCents: 0,
    });
  });

  it('si ya se hizo, el saldo ya la incluye y no se cuenta dos veces', () => {
    const result = calculateFundingShortfall(basis, { balanceCents: 161_600, contributionDone: true });
    expect(result.pendingContributionCents).toBe(0);
    expect(result.shortfallCents).toBe(13_100);
  });

  it('sin falta de dinero devuelve el sobrante', () => {
    const result = calculateFundingShortfall(basis, { balanceCents: 200_000, contributionDone: true });
    expect(result.shortfallCents).toBe(0);
    expect(result.surplusCents).toBe(25_300);
  });
});
