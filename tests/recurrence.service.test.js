import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../src/services/date.service.js';
import { calculateNextDueDate } from '../src/services/recurrence.service.js';

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
