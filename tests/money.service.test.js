import { describe, expect, it } from 'vitest';

import {
  applyMarginCents,
  centsToEuros,
  eurosToCents,
  roundDivide,
  splitAmount,
} from '../src/services/money.service.js';

describe('money.service', () => {
  it('convierte euros sin usar Float como representación persistente', () => {
    expect(eurosToCents('904,99')).toBe(90_499);
    expect(centsToEuros(90_499)).toBe('904.99');
    expect(() => eurosToCents('1.001')).toThrow(/dos decimales/);
  });

  it('redondea una única vez al céntimo', () => {
    expect(roundDivide(5, 2)).toBe(3);
    expect(roundDivide(4, 2)).toBe(2);
    expect(roundDivide(-5, 2)).toBe(-3);
  });

  it('aplica un margen del 10 % exactamente', () => {
    expect(applyMarginCents(7_500, 1_000)).toBe(8_250);
  });

  it('reparte todos los céntimos aunque una persona no tenga cuenta', () => {
    const result = splitAmount(10_001, [
      { id: 'persona-sin-usuario', contributionBps: 5_000, sortOrder: 0 },
      { id: 'persona-con-usuario', contributionBps: 5_000, sortOrder: 1 },
    ]);

    expect(result).toEqual([
      { id: 'persona-sin-usuario', amountCents: 5_001 },
      { id: 'persona-con-usuario', amountCents: 5_000 },
    ]);
    expect(result.reduce((sum, item) => sum + item.amountCents, 0)).toBe(10_001);
  });
});
