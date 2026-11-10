import { afterEach, describe, expect, it } from 'vitest';

import { businessToday, setDefaultBusinessTimezone } from '../src/services/businessClock.service.js';

describe('businessToday', () => {
  afterEach(() => setDefaultBusinessTimezone('UTC'));

  it('usa la zona horaria configurada: a las 00:30 del 1 de diciembre en Madrid ya es diciembre', () => {
    const halfPastMidnightMadrid = new Date('2026-11-30T23:30:00.000Z');
    expect(businessToday(undefined, halfPastMidnightMadrid).toISOString().slice(0, 10)).toBe('2026-11-30');
    setDefaultBusinessTimezone('Europe/Madrid');
    expect(businessToday(undefined, halfPastMidnightMadrid).toISOString().slice(0, 10)).toBe('2026-12-01');
  });

  it('rechaza una zona horaria inválida', () => {
    expect(() => setDefaultBusinessTimezone('Mars/Olympus')).toThrow(RangeError);
  });
});
