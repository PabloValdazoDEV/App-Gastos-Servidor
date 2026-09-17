import { describe, expect, it } from 'vitest';

import { calculateMonthlyStandardBudget } from '../src/services/budgetCalculator.service.js';
import { calculateMonthlySpendingProgress } from '../src/services/monthlySpendingProgress.service.js';

const base = {
  calculationDate: '2026-09-17',
  commonBudgetCents: 120_000,
  commonBalanceCents: 145_000,
};
const paid = (overrides = {}) => ({
  status: 'PAID',
  dueDate: '2026-09-15',
  paymentDate: '2026-09-15',
  expectedAmountCents: 1_500,
  actualAmountCents: 1_599,
  recurringExpense: { scope: 'HOUSEHOLD', personalPersonId: null },
  ...overrides,
});
const variable = (overrides = {}) => ({
  scope: 'HOUSEHOLD',
  year: 2026,
  month: 9,
  entryMode: 'DETAIL',
  entries: [{ amountCents: 11_000 }, { amountCents: 7_000 }],
  ...overrides,
});
const invoice = (overrides = {}) => ({
  scope: 'HOUSEHOLD',
  amountCents: 10_000,
  periodStart: '2026-07-01',
  periodEnd: '2026-08-31',
  invoiceDate: '2026-09-02',
  chargeDate: '2026-09-20',
  ...overrides,
});
const calculate = (overrides = {}) => calculateMonthlySpendingProgress({ ...base, ...overrides });
const common = (overrides = {}) => calculate(overrides).monthlyProgress.common;

describe('calculateMonthlySpendingProgress', () => {
  it('mantiene todo el presupuesto pendiente cuando no existe gasto real', () => {
    expect(common()).toEqual({
      budgetCents: 120_000,
      usedCents: 0,
      rawRemainingCents: 120_000,
      remainingCents: 120_000,
      overBudgetCents: 0,
      progressBps: 0,
      status: 'WITHIN_BUDGET',
    });
    expect(calculate().monthlyProgress.personal).toBeNull();
  });

  it('reproduce el ejemplo 1200 de presupuesto, 580 utilizados y 830 de colchón', () => {
    const result = calculate({
      payments: [paid({ actualAmountCents: 30_000 })],
      variableMonths: [variable()],
      invoices: [invoice()],
    });
    expect(result.monthlyProgress.common).toMatchObject({
      budgetCents: 120_000,
      usedCents: 58_000,
      remainingCents: 62_000,
      overBudgetCents: 0,
      progressBps: 4_833,
    });
    expect(result.cashCoverage.common).toEqual({
      balanceCents: 145_000,
      remainingBudgetCents: 62_000,
      cushionCents: 83_000,
      shortfallCents: 0,
      status: 'COVERED',
    });
  });

  it('PAID utiliza el importe real, sin reutilizar el previsto', () => {
    expect(common({ payments: [paid()] }).usedCents).toBe(1_599);
  });

  it('SKIPPED no consume presupuesto incluso si llegaran importes inconsistentes', () => {
    expect(common({ payments: [paid({ status: 'SKIPPED' })] }).usedCents).toBe(0);
  });

  it('rechaza PAID sin actualAmount: el CHECK de integridad exige ese importe', () => {
    expect(() => common({ payments: [paid({ actualAmountCents: null })] })).toThrow(TypeError);
  });

  it('atribuye un pago tardío al mes de dueDate, no al de paymentDate', () => {
    const payment = paid({ dueDate: '2026-09-30', paymentDate: '2026-10-02' });
    expect(common({ payments: [payment] }).usedCents).toBe(1_599);
    expect(common({ calculationDate: '2026-10-02', payments: [payment] }).usedCents).toBe(0);
  });

  it('un pago adelantado no consume el presupuesto del mes de paymentDate', () => {
    expect(common({
      payments: [paid({ dueDate: '2026-10-01', paymentDate: '2026-09-30' })],
    }).usedCents).toBe(0);
  });

  it('conserva pagos materializados aunque el recurrente ahora esté archivado', () => {
    expect(common({ payments: [paid({ recurringExpense: {
      scope: 'HOUSEHOLD', isActive: false, archivedAt: new Date('2026-09-16'),
    } })] }).usedCents).toBe(1_599);
  });

  it('DETAIL suma entries reales, incluso durante un mes sin completar', () => {
    expect(common({ variableMonths: [variable({ isComplete: false, summaryAmountCents: 90_000 })] }).usedCents)
      .toBe(18_000);
  });

  it('SUMMARY usa exclusivamente summaryAmountCents', () => {
    expect(common({ variableMonths: [variable({ entryMode: 'SUMMARY', summaryAmountCents: 25_000 })] }).usedCents)
      .toBe(25_000);
  });

  it('excluye variables de otro año o mes sin cambiar las recomendaciones históricas', () => {
    expect(common({ variableMonths: [variable({ month: 8 }), variable({ year: 2025 })] }).usedCents).toBe(0);
  });

  it('DETAIL vacío tiene gasto real cero', () => {
    expect(common({ variableMonths: [variable({ entries: [] })] }).usedCents).toBe(0);
  });

  it('facturas priorizan chargeDate y no reparten el importe por el periodo de consumo', () => {
    expect(common({ invoices: [invoice({ invoiceDate: '2026-08-30' })] }).usedCents).toBe(10_000);
  });

  it.each([null, undefined])('factura sin chargeDate=%s utiliza invoiceDate', (chargeDate) => {
    expect(common({ invoices: [invoice({ chargeDate })] }).usedCents).toBe(10_000);
  });

  it('factura con chargeDate de otro mes no suma aunque invoiceDate sea del mes', () => {
    expect(common({ invoices: [invoice({ chargeDate: '2026-10-03' })] }).usedCents).toBe(0);
  });

  it('factura sin chargeDate tampoco suma si invoiceDate pertenece a otro mes', () => {
    expect(common({ invoices: [invoice({ chargeDate: null, invoiceDate: '2026-10-03' })] }).usedCents).toBe(0);
  });

  it('puntuales aumentan el presupuesto restante pero nunca representan pagos por existir', () => {
    const oneTimeExpenses = [{
      id: 'purchase', name: 'Compra prevista', scope: 'HOUSEHOLD',
      amountCents: 5_000, expenseDate: '2026-09-20',
    }];
    const budget = calculateMonthlyStandardBudget({
      calculationDate: base.calculationDate,
      people: [{ id: 'viewer', contributionBps: 10_000 }],
      oneTimeExpenses,
    });
    expect(common({ commonBudgetCents: budget.householdBudgetCents, oneTimeExpenses })).toMatchObject({
      budgetCents: 5_000, usedCents: 0, remainingCents: 5_000,
    });
  });

  it('el margen forma parte del presupuesto, nunca del gasto real', () => {
    const budget = calculateMonthlyStandardBudget({
      calculationDate: base.calculationDate,
      householdMarginBps: 1_000,
      people: [{ id: 'viewer', contributionBps: 10_000 }],
      recurringExpenses: [{ amountCents: 10_000, frequency: 'MONTHLY', scope: 'HOUSEHOLD' }],
    });
    expect(common({
      commonBudgetCents: budget.householdBudgetCents,
      payments: [paid({ actualAmountCents: 9_200 })],
    })).toMatchObject({ budgetCents: 11_000, usedCents: 9_200, remainingCents: 1_800 });
  });

  it('el exceso conserva remaining crudo negativo y un porcentaje superior a 100', () => {
    expect(common({ commonBudgetCents: 50_000, payments: [paid({ actualAmountCents: 56_000 })] }))
      .toEqual({
        budgetCents: 50_000, usedCents: 56_000, rawRemainingCents: -6_000,
        remainingCents: 0, overBudgetCents: 6_000, progressBps: 11_200, status: 'OVER_BUDGET',
      });
  });

  it.each([
    [79_999, 'WITHIN_BUDGET'], [80_000, 'NEAR_LIMIT'],
    [100_000, 'NEAR_LIMIT'], [100_001, 'OVER_BUDGET'],
  ])('aplica el umbral exacto y no alarmista del 80%% a %s céntimos', (usedCents, status) => {
    expect(common({ commonBudgetCents: 100_000, payments: [paid({ actualAmountCents: usedCents })] }).status)
      .toBe(status);
  });

  it('no confunde porcentaje redondeado con el umbral real', () => {
    const progress = common({ commonBudgetCents: 1_000_000, payments: [paid({ actualAmountCents: 799_999 })] });
    expect(progress.progressBps).toBe(8_000);
    expect(progress.status).toBe('WITHIN_BUDGET');
  });

  it('la falta de saldo se calcula contra lo restante, no el presupuesto completo', () => {
    expect(calculate({
      commonBalanceCents: 45_000,
      payments: [paid({ actualAmountCents: 50_000 })],
    }).cashCoverage.common).toEqual({
      balanceCents: 45_000, remainingBudgetCents: 70_000,
      cushionCents: -25_000, shortfallCents: 25_000, status: 'SHORTFALL',
    });
  });

  it('presupuesto superado y saldo suficiente son estados independientes', () => {
    const result = calculate({
      commonBudgetCents: 100_000, commonBalanceCents: 200_000,
      payments: [paid({ actualAmountCents: 110_000 })],
    });
    expect(result.monthlyProgress.common.status).toBe('OVER_BUDGET');
    expect(result.cashCoverage.common).toMatchObject({ status: 'COVERED', cushionCents: 200_000 });
  });

  it('un saldo negativo se mantiene como falta de saldo aunque el presupuesto restante sea cero', () => {
    expect(calculate({ commonBudgetCents: 0, commonBalanceCents: -100 }).cashCoverage.common)
      .toMatchObject({ cushionCents: -100, shortfallCents: 100, status: 'SHORTFALL' });
  });

  it('saldo exactamente igual al presupuesto restante está cubierto sin colchón', () => {
    expect(calculate({ commonBalanceCents: 120_000 }).cashCoverage.common)
      .toMatchObject({ cushionCents: 0, shortfallCents: 0, status: 'COVERED' });
  });

  it('separa las tres fuentes HOUSEHOLD/PERSONAL y excluye otra persona en el cálculo', () => {
    const personal = { scope: 'PERSONAL', personalPersonId: 'viewer' };
    const privateOther = { scope: 'PERSONAL', personalPersonId: 'other' };
    const result = calculate({
      viewerPersonId: 'viewer', personalBudgetCents: 10_000, personalBalanceCents: 4_000,
      payments: [paid(), paid({ actualAmountCents: 100, recurringExpense: personal }),
        paid({ actualAmountCents: 900_000, recurringExpense: privateOther })],
      variableMonths: [variable(), variable({ ...personal, entries: [{ amountCents: 200 }] }),
        variable({ ...privateOther, entries: [{ amountCents: 900_000 }] })],
      invoices: [invoice(), invoice({ ...personal, amountCents: 300 }),
        invoice({ ...privateOther, amountCents: 900_000 })],
    });
    expect(result.monthlyProgress.common.usedCents).toBe(29_599);
    expect(result.monthlyProgress.personal).toMatchObject({
      personId: 'viewer', budgetCents: 10_000, usedCents: 600, remainingCents: 9_400,
    });
    expect(result.cashCoverage.personal).toEqual({
      personId: 'viewer', balanceCents: 4_000, remainingBudgetCents: 9_400,
      cushionCents: -5_400, shortfallCents: 5_400, status: 'SHORTFALL',
    });
    expect(result.monthlyProgress).not.toHaveProperty('viewerTotal');
    expect(JSON.stringify(result)).not.toContain('900000');
  });

  it('sin viewer explícito no devuelve datos personales aunque el caller envíe registros', () => {
    const result = calculate({
      personalBudgetCents: 99_999, personalBalanceCents: 99_999,
      payments: [paid({ recurringExpense: { scope: 'PERSONAL', personalPersonId: 'other' } })],
    });
    expect(result.monthlyProgress.common.usedCents).toBe(0);
    expect(result.monthlyProgress.personal).toBeNull();
    expect(result.cashCoverage.personal).toBeNull();
  });

  it('no interpreta scopes ausentes o desconocidos como gastos comunes', () => {
    expect(common({
      payments: [paid({ recurringExpense: null })],
      variableMonths: [variable({ scope: undefined })],
      invoices: [invoice({ scope: 'UNKNOWN' })],
    }).usedCents).toBe(0);
  });

  it('saldo personal no registrado no equivale a saldo cero', () => {
    const result = calculate({ viewerPersonId: 'viewer', personalBudgetCents: 10_000 });
    expect(result.monthlyProgress.personal.remainingCents).toBe(10_000);
    expect(result.cashCoverage.personal).toBeNull();
    expect(calculate({ viewerPersonId: 'viewer', personalBudgetCents: 10_000, personalBalanceCents: 0 })
      .cashCoverage.personal.status).toBe('SHORTFALL');
  });

  it.each(['2026-12-01', '2026-12-31'])('diciembre %s incluye sus extremos y excluye enero', (calculationDate) => {
    expect(common({ calculationDate, payments: [
      paid({ dueDate: new Date('2026-12-01T00:00:00.000Z'), actualAmountCents: 100 }),
      paid({ dueDate: new Date('2026-12-31T00:00:00.000Z'), paymentDate: '2027-01-02', actualAmountCents: 200 }),
      paid({ dueDate: new Date('2027-01-01T00:00:00.000Z'), actualAmountCents: 400 }),
    ] }).usedCents).toBe(300);
  });

  it.each(['2027-01-01', '2027-01-31'])('enero %s no arrastra pagos, variables ni facturas de diciembre', (calculationDate) => {
    expect(common({
      calculationDate,
      payments: [paid({ dueDate: '2026-12-31', paymentDate: '2027-01-02' }),
        paid({ dueDate: '2027-01-31', actualAmountCents: 100 })],
      variableMonths: [variable({ year: 2026, month: 12 }),
        variable({ year: 2027, month: 1, entries: [{ amountCents: 200 }] })],
      invoices: [invoice({ chargeDate: '2026-12-31', invoiceDate: '2027-01-01' }),
        invoice({ chargeDate: null, invoiceDate: '2027-01-01', amountCents: 300 })],
    }).usedCents).toBe(600);
  });

  it('editar PAID modifica used y pasar a SKIPPED lo elimina, sin estado acumulado', () => {
    const payment = paid();
    expect(common({ payments: [payment] }).usedCents).toBe(1_599);
    expect(common({ payments: [{ ...payment, actualAmountCents: 2_000 }] }).usedCents).toBe(2_000);
    expect(common({ payments: [{ ...payment, status: 'SKIPPED', actualAmountCents: null }] }).usedCents).toBe(0);
  });

  it('presupuesto cero y usado cero produce 0%, no un porcentaje indefinido', () => {
    expect(common({ commonBudgetCents: 0 })).toMatchObject({
      usedCents: 0, remainingCents: 0, overBudgetCents: 0, progressBps: 0, status: 'WITHIN_BUDGET',
    });
  });

  it('presupuesto cero con gasto conserva el exceso y representa el porcentaje indefinido con null', () => {
    const result = calculate({ commonBudgetCents: 0, payments: [paid()] });
    expect(result.monthlyProgress.common).toMatchObject({
      usedCents: 1_599, rawRemainingCents: -1_599, remainingCents: 0,
      overBudgetCents: 1_599, progressBps: null, status: 'OVER_BUDGET',
    });
    expect(JSON.stringify(result)).not.toContain('Infinity');
  });

  it('configuración incompleta no inventa presupuestos ni coberturas de cero', () => {
    expect(calculate({ commonBudgetCents: null })).toEqual({ monthlyProgress: null, cashCoverage: null });
  });

  it('opera en céntimos exactos y redondea los puntos básicos con helpers monetarios', () => {
    expect(common({ commonBudgetCents: 3, payments: [paid({ actualAmountCents: 1 })] }))
      .toMatchObject({ usedCents: 1, remainingCents: 2, progressBps: 3_333 });
    expect(common({ commonBudgetCents: 32, payments: [paid({ actualAmountCents: 1 })] }).progressBps).toBe(313);
  });

  it('BigInt mantiene la precisión cuando la multiplicación del porcentaje supera MAX_SAFE_INTEGER', () => {
    const budget = Number.MAX_SAFE_INTEGER - 1;
    expect(common({ commonBudgetCents: budget, payments: [paid({ actualAmountCents: budget / 2 })] }))
      .toMatchObject({ usedCents: budget / 2, remainingCents: budget / 2, progressBps: 5_000 });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rechaza importes de presupuesto inválidos %s', (commonBudgetCents) => {
    expect(() => common({ commonBudgetCents })).toThrow();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rechaza gasto real inválido %s', (actualAmountCents) => {
    expect(() => common({ payments: [paid({ actualAmountCents })] })).toThrow();
  });

  it('rechaza acumulados de céntimos que no se puedan serializar con seguridad', () => {
    expect(() => common({ variableMonths: [variable({ entries: [
      { amountCents: Number.MAX_SAFE_INTEGER }, { amountCents: 1 },
    ] })] })).toThrow(TypeError);
  });

  it('rechaza una cobertura que desborde el rango monetario seguro', () => {
    expect(() => calculate({ commonBudgetCents: Number.MAX_SAFE_INTEGER, commonBalanceCents: -1 }))
      .toThrow(TypeError);
  });

  it('es puro y no modifica los registros recibidos', () => {
    const inputs = { ...base, payments: [paid()], variableMonths: [variable()], invoices: [invoice()] };
    const original = structuredClone(inputs);
    expect(calculateMonthlySpendingProgress(inputs)).toEqual(calculateMonthlySpendingProgress(inputs));
    expect(inputs).toEqual(original);
  });
});
