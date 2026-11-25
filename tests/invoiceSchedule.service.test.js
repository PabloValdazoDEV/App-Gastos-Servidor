import { describe, expect, it } from 'vitest';

import {
  advanceScheduleAfterInvoice,
  estimateScheduleAmount,
  scheduleOccurrences,
} from '../src/services/invoiceSchedule.service.js';

const light = {
  id: 'light', categoryId: 'cat-light', scope: 'HOUSEHOLD', personalPersonId: null, isActive: true,
  frequency: 'BIMONTHLY', usualDayOfMonth: 10, nextExpectedDate: '2027-01-10', endDate: null,
};

describe('estimateScheduleAmount', () => {
  it('usa la media de las 3 últimas facturas de la propia factura periódica', () => {
    const invoices = [
      { scheduleId: 'light', categoryId: 'cat-light', scope: 'HOUSEHOLD', invoiceDate: '2026-05-10', amountCents: 1 },
      { scheduleId: 'light', categoryId: 'cat-light', scope: 'HOUSEHOLD', invoiceDate: '2026-07-10', amountCents: 9_000 },
      { scheduleId: 'light', categoryId: 'cat-light', scope: 'HOUSEHOLD', invoiceDate: '2026-09-10', amountCents: 9_240 },
      { scheduleId: 'light', categoryId: 'cat-light', scope: 'HOUSEHOLD', invoiceDate: '2026-11-10', amountCents: 7_810 },
    ];
    expect(estimateScheduleAmount(light, invoices)).toEqual({ amountCents: 8_683, basedOn: 3, source: 'SCHEDULE' });
  });

  it('sin facturas propias usa las de la misma categoría y titular; sin nada, no inventa importe', () => {
    const invoices = [
      { scheduleId: null, categoryId: 'cat-light', scope: 'HOUSEHOLD', invoiceDate: '2026-09-10', amountCents: 8_000 },
      { scheduleId: null, categoryId: 'cat-light', scope: 'PERSONAL', personalPersonId: 'p1', invoiceDate: '2026-10-10', amountCents: 99_999 },
      { scheduleId: null, categoryId: 'cat-gas', scope: 'HOUSEHOLD', invoiceDate: '2026-10-10', amountCents: 99_999 },
    ];
    expect(estimateScheduleAmount(light, invoices)).toEqual({ amountCents: 8_000, basedOn: 1, source: 'CATEGORY' });
    expect(estimateScheduleAmount(light, [])).toEqual({ amountCents: null, basedOn: 0, source: null });
  });
});

describe('scheduleOccurrences', () => {
  it('lista las fechas previstas dentro del rango y se detiene en la fecha de fin', () => {
    expect(scheduleOccurrences(light, '2027-01-01', '2027-06-30')).toEqual(['2027-01-10', '2027-03-10', '2027-05-10']);
    expect(scheduleOccurrences({ ...light, endDate: '2027-04-01' }, '2027-01-01', '2027-06-30')).toEqual(['2027-01-10', '2027-03-10']);
    expect(scheduleOccurrences({ ...light, isActive: false }, '2027-01-01', '2027-06-30')).toEqual([]);
  });

  it('cada 4 semanas usa semanas, no meses', () => {
    const phone = { ...light, frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, usualDayOfMonth: null, nextExpectedDate: '2027-01-05' };
    expect(scheduleOccurrences(phone, '2027-01-01', '2027-02-28')).toEqual(['2027-01-05', '2027-02-02']);
  });
});

describe('advanceScheduleAfterInvoice', () => {
  it('una factura que llega unos días antes o después mueve la siguiente un ciclo', () => {
    expect(advanceScheduleAfterInvoice(light, '2027-01-05').toISOString().slice(0, 10)).toBe('2027-03-10');
    expect(advanceScheduleAfterInvoice(light, '2027-01-20').toISOString().slice(0, 10)).toBe('2027-03-10');
  });

  it('una factura antigua apuntada después no mueve la fecha prevista', () => {
    expect(advanceScheduleAfterInvoice(light, '2026-11-10').toISOString().slice(0, 10)).toBe('2027-01-10');
  });
});
