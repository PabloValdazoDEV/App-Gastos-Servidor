import { describe, expect, it } from 'vitest';

import { buildFundingBasis, calculateFundingShortfall, recoveryOptions } from '../src/services/fundingCheck.service.js';
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

  it('el ahorro para pagos grandes es el que debería haber a final de mes', () => {
    // Annual 360 € insurance, cycle of 365 days, 320 elapsed on 1 December.
    const basis = buildFundingBasis({
      ...base,
      reserveLines: [reserveLine({ dueDate: '2027-01-15', reserveCents: 31_562, targetAmountCents: 36_000, totalDays: 365, elapsedDays: 320 })],
      calculationDate: '2026-12-01',
    });
    // 320 + 31 days of December = 351 / 365 of 360 €.
    expect(basis.reserveForLaterCents).toBe(34_619);
  });

  it('sin falta de dinero ningún pago queda en riesgo aunque venza el mes siguiente', () => {
    const basis = buildFundingBasis({
      ...base,
      reserveLines: [reserveLine({ dueDate: '2027-01-15', reserveCents: 31_562, targetAmountCents: 36_000, totalDays: 365, elapsedDays: 320 })],
      calculationDate: '2026-12-01',
    });
    // A tiny shortfall over 2 months: January's provision completes the insurance.
    const [twoMonths] = recoveryOptions(basis, { shortfallCents: 1_000, calculationDate: '2026-12-01', months: [2] });
    expect(twoMonths.safe).toBe(true);
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

describe('recoveryOptions', () => {
  // Annual 600 € insurance due in March (4 months after November), 400 € saved.
  const basis = {
    reserveForLaterCents: 40_000,
    reserveForLaterLines: [{ name: 'Seguro coche', dueDate: '2027-03-02', reserveCents: 40_000, targetAmountCents: 60_000, cycleDays: 365 }],
  };

  it('solo ofrece repartir en los meses que no dejan ningún pago sin cubrir', () => {
    const options = recoveryOptions(basis, { shortfallCents: 30_000, calculationDate: '2026-11-01' });
    expect(options.map(({ months, monthlyCents, safe }) => ({ months, monthlyCents, safe }))).toEqual([
      { months: 2, monthlyCents: 15_000, safe: true },
      { months: 3, monthlyCents: 10_000, safe: true },
      { months: 6, monthlyCents: 5_000, safe: false },
    ]);
    expect(options[2].risk).toEqual({ name: 'Seguro coche', dueDate: '2027-03-02' });
  });

  it('si lo que falta son pagos de este mes, no se puede repartir', () => {
    const options = recoveryOptions({ reserveForLaterCents: 0, reserveForLaterLines: [] }, { shortfallCents: 60_000, calculationDate: '2026-11-01' });
    expect(options.every((option) => !option.safe)).toBe(true);
    expect(options[0].risk).toEqual({ name: 'Los pagos de este mes', dueDate: null });
  });

  it('sin falta de dinero no hay opciones', () => {
    expect(recoveryOptions(basis, { shortfallCents: 0, calculationDate: '2026-11-01' })).toEqual([]);
  });
});
