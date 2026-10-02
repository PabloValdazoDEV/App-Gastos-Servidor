import { describe, expect, it } from 'vitest';
import { buildCalendar } from '../src/services/calendar.service.js';

const common = { scope: 'HOUSEHOLD', category: { id: 'food', name: 'Comida' } };
const build = (inputs = {}) => buildCalendar({ recurringExpenses: [], today: '2026-10-15', view: 'MONTH', ...inputs });

describe('calendar with all expense types', () => {
  it('combines sources chronologically without assigning payment actions to recorded expenses', () => {
    const { events } = build({
      recurringExpenses: [{ ...common, id: 'rent', name: 'Alquiler', nextDueDate: '2026-10-02', amountCents: 80000 }],
      invoices: [{ ...common, id: 'invoice', invoiceDate: '2026-10-04', amountCents: 3000 }],
      variableMonths: [{ ...common, id: 'month', entryMode: 'DETAIL', year: 2026, month: 10,
        entries: [{ id: 'entry', spentOn: '2026-10-06', merchant: 'Supermercado', amountCents: 2400 }] }],
      oneTimeExpenses: [{ ...common, id: 'repair', name: 'Reparación', expenseDate: '2026-10-08', amountCents: 4000 }],
      purchaseSources: [{ ...common, id: 'purchase', sourceType: 'PURCHASE_UPFRONT', dueDate: '2026-10-10', status: 'PAID', actualAmountCents: 5000, paidAt: '2026-10-10' }],
    });
    expect(events.map((event) => event.sourceType)).toEqual(['RECURRING_EXPENSE', 'INVOICE', 'VARIABLE_EXPENSE', 'ONE_TIME_EXPENSE', 'PURCHASE_UPFRONT']);
    expect(events[1]).toMatchObject({ status: 'RECORDED', amountCents: 3000, dateBasis: 'INVOICE_DATE' });
    expect(events[2]).toMatchObject({ id: 'entry', variableMonthId: 'month', name: 'Supermercado', amountCents: 2400 });
    expect(events[3]).toMatchObject({ status: 'UNCONFIRMED', actualAmountCents: null, expectedAmountCents: 4000 });
    for (const event of events.slice(1, 4)) expect(event).toMatchObject({ canRegisterPayment: false, canEditPayment: false, paymentId: null, paymentDate: null });
  });

  it('uses charge date before invoice date, includes range boundaries and excludes other periods', () => {
    const { events } = build({ invoices: [
      { ...common, id: 'first', invoiceDate: '2026-09-30', chargeDate: '2026-10-01', amountCents: 100 },
      { ...common, id: 'last', invoiceDate: '2026-10-31', amountCents: 200 },
      { ...common, id: 'next', invoiceDate: '2026-10-15', chargeDate: '2026-11-01', amountCents: 300 },
      { ...common, id: 'previous', invoiceDate: '2026-09-30', amountCents: 400 },
    ] });
    expect(events.map((event) => [event.id, event.dueDate, event.dateBasis])).toEqual([
      ['first', '2026-10-01', 'CHARGE_DATE'], ['last', '2026-10-31', 'INVOICE_DATE'],
    ]);
  });

  it('includes a complete monthly summary when a rolling range overlaps it, without duplicating detail', () => {
    const { events } = build({ view: '30_DAYS', variableMonths: [
      { ...common, id: 'summary', year: 2026, month: 10, entryMode: 'SUMMARY', summaryAmountCents: 9000,
        entries: [{ id: 'stale', spentOn: '2026-10-16', amountCents: 9000 }] },
      { ...common, id: 'next', year: 2026, month: 11, entryMode: 'SUMMARY', summaryAmountCents: 0 },
      { ...common, id: 'past', year: 2026, month: 9, entryMode: 'SUMMARY', summaryAmountCents: 5000 },
    ] });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: 'summary', datePrecision: 'MONTH', periodStart: '2026-10-01', periodEnd: '2026-10-31', daysFromToday: null, amountCents: 9000 });
    expect(events[1]).toMatchObject({ id: 'next', amountCents: 0 });
  });

  it('shows each detailed variable once by its own date, even if the month is incomplete', () => {
    const { events } = build({ variableMonths: [{ ...common, id: 'detail', year: 2026, month: 10, entryMode: 'DETAIL', isComplete: false, summaryAmountCents: 99999,
      entries: [
        { id: 'b', spentOn: '2026-10-31', amountCents: 200 },
        { id: 'a', spentOn: '2026-10-01', amountCents: 100 },
        { id: 'outside', spentOn: '2026-11-01', amountCents: 500 },
      ],
    }], oneTimeExpenses: [{ ...common, id: 'past', name: 'Antiguo', expenseDate: '2026-09-30', amountCents: 100 }] });
    expect(events.map((event) => [event.id, event.amountCents])).toEqual([['a', 100], ['b', 200]]);
  });

  it('handles year changes, leap months and same-day records with stable identifiers', () => {
    const { events } = build({ today: '2024-02-29', view: 'MONTH', variableMonths: [{ ...common, id: 'leap', year: 2024, month: 2, entryMode: 'SUMMARY', summaryAmountCents: 100 }],
      invoices: ['b', 'a'].map((id) => ({ ...common, id, invoiceDate: '2024-02-29', amountCents: 100 })) });
    expect(events[0].periodEnd).toBe('2024-02-29');
    expect(events.slice(1).map((event) => event.id)).toEqual(['a', 'b']);
    const acrossYears = build({ today: '2026-12-20', view: '30_DAYS', variableMonths: [
      { ...common, id: 'dec', year: 2026, month: 12, entryMode: 'SUMMARY', summaryAmountCents: 100 },
      { ...common, id: 'jan', year: 2027, month: 1, entryMode: 'SUMMARY', summaryAmountCents: 200 },
    ] });
    expect(acrossYears.events.map((event) => event.id)).toEqual(['dec', 'jan']);
  });
});
