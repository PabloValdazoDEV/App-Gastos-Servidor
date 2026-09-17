import { describe, expect, it } from 'vitest';

import {
  calculateMonthlyStandardBudget,
  monthlyEquivalentCents,
} from '../src/services/budgetCalculator.service.js';
import { buildCalendar } from '../src/services/calendar.service.js';
import { differenceInCalendarDays, toIsoDate } from '../src/services/date.service.js';
import {
  calculateSimulation,
  calculateTheoreticalReserve,
} from '../src/services/planningCalculator.service.js';
import {
  calculateNextDueDate,
  customWeeksIntervalDays,
} from '../src/services/recurrence.service.js';

const people = [{ id: 'person', name: 'Persona', contributionBps: 10_000 }];
const gym = {
  id: 'gym',
  name: 'Gimnasio',
  amountCents: 4_000,
  frequency: 'CUSTOM_WEEKS',
  intervalWeeks: 4,
  intervalMonths: null,
  scope: 'HOUSEHOLD',
  startDate: '2026-09-17',
  nextDueDate: '2026-09-17',
  usualDayOfMonth: 17,
  isActive: true,
};
const invalidIntervals = [undefined, null, 0, 1, -2, 2.5, 521, '4', NaN, Infinity];

describe('CUSTOM_WEEKS: fechas civiles y compatibilidad', () => {
  it('mantiene WEEKLY en siete días sin requerir intervalo', () => {
    expect(toIsoDate(calculateNextDueDate('2026-09-17', 'WEEKLY'))).toBe('2026-09-24');
  });

  it.each([
    [2, '2026-10-01'],
    [3, '2026-10-08'],
    [4, '2026-10-15'],
    [5, '2026-10-22'],
  ])('cada %i semanas avanza días reales e ignora el día habitual', (weeks, expected) => {
    expect(toIsoDate(calculateNextDueDate('2026-09-17', 'CUSTOM_WEEKS', null, 31, weeks))).toBe(expected);
  });

  it('mantiene todos los intervalos de 28 días al cambiar de mes y año', () => {
    let current = gym.nextDueDate;
    const dates = [];
    for (let index = 0; index < 4; index += 1) {
      const next = calculateNextDueDate(current, 'CUSTOM_WEEKS', null, 17, 4);
      expect(differenceInCalendarDays(next, current)).toBe(28);
      dates.push(toIsoDate(next));
      current = next;
    }
    expect(dates).toEqual(['2026-10-15', '2026-11-12', '2026-12-10', '2027-01-07']);
  });

  it('31 de enero no convierte la frecuencia semanal en último día de mes', () => {
    const february = calculateNextDueDate('2026-01-31', 'CUSTOM_WEEKS', null, 31, 4);
    const march = calculateNextDueDate(february, 'CUSTOM_WEEKS', null, 31, 4);
    expect(toIsoDate(february)).toBe('2026-02-28');
    expect(toIsoDate(march)).toBe('2026-03-28');
  });

  it.each([
    ['2028-02-01', '2028-02-29'],
    ['2028-02-29', '2028-03-28'],
    ['2026-03-15', '2026-04-12'],
    ['2026-10-11', '2026-11-08'],
  ])('conserva cuatro semanas en año bisiesto y cambios de horario: %s', (current, expected) => {
    const next = calculateNextDueDate(current, 'CUSTOM_WEEKS', null, undefined, 4);
    expect(toIsoDate(next)).toBe(expected);
    expect(next.getUTCHours()).toBe(0);
    expect(differenceInCalendarDays(next, current)).toBe(28);
  });

  it('mantiene MONTHLY y CUSTOM_MONTHS como meses naturales', () => {
    const february = calculateNextDueDate('2026-01-31', 'MONTHLY', null, 31);
    expect(toIsoDate(february)).toBe('2026-02-28');
    expect(toIsoDate(calculateNextDueDate(february, 'MONTHLY', null, 31))).toBe('2026-03-31');
    expect(toIsoDate(calculateNextDueDate('2026-09-17', 'CUSTOM_MONTHS', 3, 17))).toBe('2026-12-17');
  });

  it('acepta el máximo de 520 semanas sin convertirlo a meses', () => {
    expect(customWeeksIntervalDays(520)).toBe(3_640);
    const next = calculateNextDueDate('2026-09-17', 'CUSTOM_WEEKS', null, undefined, 520);
    expect(differenceInCalendarDays(next, '2026-09-17')).toBe(3_640);
  });

  it.each(invalidIntervals)('rechaza intervalWeeks inválido: %s', (intervalWeeks) => {
    expect(() => calculateNextDueDate('2026-09-17', 'CUSTOM_WEEKS', null, undefined, intervalWeeks)).toThrow(RangeError);
  });
});

describe('CUSTOM_WEEKS: equivalente mensual y márgenes recurrentes', () => {
  it.each([
    [2, 8_667],
    [3, 5_778],
    [4, 4_333],
    [5, 3_467],
    [520, 33],
  ])('mensualiza 40 euros cada %i semanas a %i céntimos', (intervalWeeks, expected) => {
    expect(monthlyEquivalentCents({ ...gym, intervalWeeks })).toBe(expected);
  });

  it('conserva el redondeo monetario y evita precisión intermedia de coma flotante', () => {
    expect(monthlyEquivalentCents({ ...gym, amountCents: 3, intervalWeeks: 2 })).toBe(7);
    expect(monthlyEquivalentCents({ ...gym, amountCents: Number.MAX_SAFE_INTEGER, intervalWeeks: 520 })).toBe(75_059_993_789_508);
    expect(monthlyEquivalentCents({ ...gym, amountCents: 0 })).toBe(0);
  });

  it('conserva la equivalencia semanal y mensual natural existente', () => {
    expect(monthlyEquivalentCents({ amountCents: 4_000, frequency: 'WEEKLY' })).toBe(17_333);
    expect(monthlyEquivalentCents({ amountCents: 4_000, frequency: 'MONTHLY' })).toBe(4_000);
    expect(monthlyEquivalentCents({ amountCents: 4_000, frequency: 'CUSTOM_MONTHS', intervalMonths: 3 })).toBe(1_333);
  });

  it.each([
    [null, null, 1_000, 4_766],
    [null, 2_000, 2_000, 5_200],
    [0, 2_000, 0, 4_333],
    [500, 2_000, 500, 4_550],
  ])('aplica la precedencia de margen sobre 43,33 euros (override %s, categoría %s)', (override, category, margin, amount) => {
    const budget = calculateMonthlyStandardBudget({
      calculationDate: '2026-09-17',
      people,
      householdMarginBps: 1_000,
      recurringExpenses: [{ ...gym, safetyMarginOverrideBps: override, category: { safetyMarginBps: category } }],
    });
    expect(budget.lines[0]).toMatchObject({ baseCents: 4_333, effectiveMarginBps: margin, amountCents: amount });
    expect(budget.householdBaseBudgetCents).toBe(4_333);
    expect(budget.householdBudgetCents).toBe(amount);
  });

  it.each(invalidIntervals)('el cálculo tampoco acepta intervalWeeks inválido: %s', (intervalWeeks) => {
    expect(() => monthlyEquivalentCents({ ...gym, intervalWeeks })).toThrow(RangeError);
  });
});

describe('CUSTOM_WEEKS: calendario', () => {
  it.each([
    ['MONTH', ['2026-09-17']],
    ['30_DAYS', ['2026-09-17', '2026-10-15']],
    ['90_DAYS', ['2026-09-17', '2026-10-15', '2026-11-12', '2026-12-10']],
    ['YEAR', ['2026-09-17', '2026-10-15', '2026-11-12', '2026-12-10']],
  ])('expande las ocurrencias en la vista %s', (view, dates) => {
    const calendar = buildCalendar({ recurringExpenses: [gym], today: '2026-09-17', view });
    expect(calendar.events.map((event) => event.dueDate)).toEqual(dates);
    calendar.events.slice(1).forEach((event, index) => {
      expect(differenceInCalendarDays(event.dueDate, calendar.events[index].dueDate)).toBe(28);
    });
    expect(calendar.events[0].status).toBe('DUE');
  });

  it('la vista anual contiene 13 cobros de un ciclo de cuatro semanas iniciado el 17 de enero', () => {
    const expense = { ...gym, startDate: '2026-01-17', nextDueDate: '2026-01-17' };
    const calendar = buildCalendar({ recurringExpenses: [expense], today: '2026-01-01', view: 'YEAR' });
    expect(calendar.events).toHaveLength(13);
    expect(calendar.events.at(-1).dueDate).toBe('2026-12-19');
  });

  it('respeta endDate y conserva importes y estados de pagos históricos', () => {
    const calendar = buildCalendar({
      recurringExpenses: [{ ...gym, nextDueDate: '2026-11-12', endDate: '2026-12-01' }],
      today: '2026-10-16',
      view: 'YEAR',
      payments: [
        { id: 'paid', recurringExpenseId: gym.id, dueDate: '2026-09-17', status: 'PAID', expectedAmountCents: 4_000, actualAmountCents: 4_200, paymentDate: '2026-09-18' },
        { id: 'skipped', recurringExpenseId: gym.id, dueDate: '2026-10-15', status: 'SKIPPED', expectedAmountCents: 4_000 },
      ],
    });
    expect(calendar.events).toEqual([
      expect.objectContaining({ dueDate: '2026-09-17', status: 'PAID', amountCents: 4_200, expectedAmountCents: 4_000, actualAmountCents: 4_200 }),
      expect.objectContaining({ dueDate: '2026-10-15', status: 'SKIPPED', amountCents: 4_000 }),
      expect.objectContaining({ dueDate: '2026-11-12', status: 'UPCOMING', amountCents: 4_000 }),
    ]);
  });
});

describe('CUSTOM_WEEKS: reserva y simulación', () => {
  // Existing reserve semantics exclude charges covered by short-cycle monthly
  // contributions. Keep 2–4-week cycles in that group without changing their
  // actual dates or monthly equivalent; five weeks is already a longer cycle.
  it.each([2, 3, 4])('excluye la reserva adicional para ciclos cortos de %i semanas', (intervalWeeks) => {
    expect(calculateTheoreticalReserve([{ ...gym, intervalWeeks }], '2026-09-17')).toMatchObject({ theoreticalReserveCents: 0, lines: [] });
  });

  it.each([
    [5, '2026-09-10', 35, 14, 1_600],
    [8, '2026-08-20', 56, 35, 2_500],
  ])('infiere el ciclo anterior de %i semanas restando días reales', (intervalWeeks, cycleStart, totalDays, elapsedDays, reserveCents) => {
    const reserve = calculateTheoreticalReserve([{ ...gym, intervalWeeks, nextDueDate: '2026-10-15' }], '2026-09-24');
    expect(reserve.lines[0]).toMatchObject({ cycleStart, dueDate: '2026-10-15', totalDays, elapsedDays, reserveCents });
    expect(reserve.theoreticalReserveCents).toBe(reserveCents);
  });

  it('acota la reserva entre cero y el cobro completo y respeta un ciclo explícito', () => {
    const expense = { ...gym, intervalWeeks: 5, nextDueDate: '2026-10-15' };
    expect(calculateTheoreticalReserve([expense], '2026-09-01').theoreticalReserveCents).toBe(0);
    expect(calculateTheoreticalReserve([expense], '2026-10-16').lines[0]).toMatchObject({ reserveCents: 4_000, overdue: true });
    expect(calculateTheoreticalReserve([{ ...expense, cycleStartDate: '2026-09-01' }], '2026-09-23').lines[0]).toMatchObject({ cycleStart: '2026-09-01', totalDays: 44, elapsedDays: 22, reserveCents: 2_000 });
  });

  it('sigue excluyendo reservas personales, inactivas, mensuales y semanales', () => {
    const expenses = [
      { ...gym, intervalWeeks: 8, scope: 'PERSONAL' },
      { ...gym, intervalWeeks: 8, isActive: false },
      { ...gym, intervalWeeks: 8, archivedAt: '2026-09-01' },
      { ...gym, frequency: 'MONTHLY' },
      { ...gym, frequency: 'WEEKLY' },
    ];
    expect(calculateTheoreticalReserve(expenses, '2026-09-17').lines).toEqual([]);
  });

  it('simula el gimnasio de cuatro semanas sin sumar reserva al presupuesto', () => {
    const expense = { ...gym, nextDueDate: '2026-10-15' };
    const standardBudget = calculateMonthlyStandardBudget({ people, householdMarginBps: 1_000, recurringExpenses: [expense] });
    expect(calculateSimulation({ standardBudget, recurringExpenses: [expense], simulationDate: '2026-10-08', relevantAvailableBalanceCents: 5_000 })).toMatchObject({
      monthlyStandardBudgetCents: 4_766,
      theoreticalReserveCents: 0,
      reserveLines: [],
      upcomingPayments: [expect.objectContaining({ dueDate: '2026-10-15', daysRemaining: 7, amountCents: 4_000 })],
    });
  });

  it('la reserva cambia con la fecha simulada pero el presupuesto equivalente no se duplica', () => {
    const expense = { ...gym, intervalWeeks: 8, nextDueDate: '2026-10-15' };
    const standardBudget = calculateMonthlyStandardBudget({ people, householdMarginBps: 1_000, recurringExpenses: [expense] });
    const simulate = (simulationDate) => calculateSimulation({ standardBudget, recurringExpenses: [expense], simulationDate, relevantAvailableBalanceCents: 5_000 });
    expect(simulate('2026-09-17')).toMatchObject({ monthlyStandardBudgetCents: 2_384, theoreticalReserveCents: 2_000 });
    expect(simulate('2026-10-01')).toMatchObject({ monthlyStandardBudgetCents: 2_384, theoreticalReserveCents: 3_000 });
  });

  it.each(invalidIntervals)('la reserva rechaza intervalWeeks inválido: %s', (intervalWeeks) => {
    expect(() => calculateTheoreticalReserve([{ ...gym, intervalWeeks }], '2026-09-17')).toThrow(RangeError);
  });
});
