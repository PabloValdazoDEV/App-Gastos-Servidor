import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../src/services/date.service.js';
import {
  calculateNextDueDate,
  recurringExpenseIsInEffect,
} from '../src/services/recurrence.service.js';

describe('recurrence.service', () => {
  it('mantiene un día válido al avanzar meses', () => {
    expect(toIsoDate(calculateNextDueDate('2026-01-31', 'MONTHLY'))).toBe(
      '2026-02-28',
    );
    expect(toIsoDate(calculateNextDueDate('2026-01-31', 'QUARTERLY'))).toBe(
      '2026-04-30',
    );
  });

  it('ONE_TIME no crea otro vencimiento', () => {
    expect(calculateNextDueDate('2026-01-31', 'ONE_TIME')).toBeNull();
  });

  it('recupera el día habitual después de un mes corto', () => {
    expect(
      toIsoDate(calculateNextDueDate('2026-02-28', 'MONTHLY', null, 31)),
    ).toBe('2026-03-31');
  });
});

describe('recurringExpenseIsInEffect', () => {
  const d = (value) => new Date(`${value}T00:00:00.000Z`);
  const loan = {
    frequency: 'MONTHLY',
    startDate: d('2024-01-05'),
    nextDueDate: d('2025-03-05'),
    endDate: d('2025-03-31'),
  };

  it('deja de contar un préstamo cuya fecha de fin ya pasó', () => {
    expect(recurringExpenseIsInEffect(loan, '2026-11-06')).toBe(false);
  });

  it('cuenta el préstamo en el mes de su último vencimiento pendiente', () => {
    expect(recurringExpenseIsInEffect(loan, '2025-03-01')).toBe(true);
  });

  it('deja de contar cuando el último vencimiento ya está pagado', () => {
    expect(
      recurringExpenseIsInEffect({ ...loan, nextDueDate: d('2025-04-05') }, '2025-03-20'),
    ).toBe(false);
  });

  it('no cuenta un gasto mensual que empieza en un mes futuro', () => {
    const gym = { frequency: 'MONTHLY', startDate: d('2027-01-10'), nextDueDate: d('2027-01-10') };
    expect(recurringExpenseIsInEffect(gym, '2026-11-06')).toBe(false);
    expect(recurringExpenseIsInEffect(gym, '2027-01-02')).toBe(true);
  });

  it('sigue reservando para un gasto anual antes de su primer vencimiento', () => {
    const insurance = { frequency: 'YEARLY', startDate: d('2027-03-01'), nextDueDate: d('2027-03-01') };
    expect(recurringExpenseIsInEffect(insurance, '2026-11-06')).toBe(true);
  });

  it('cuenta siempre un gasto sin fecha de fin ya iniciado', () => {
    const rent = { frequency: 'MONTHLY', startDate: d('2024-01-01'), nextDueDate: d('2026-12-01'), endDate: null };
    expect(recurringExpenseIsInEffect(rent, '2026-11-06')).toBe(true);
  });
});
