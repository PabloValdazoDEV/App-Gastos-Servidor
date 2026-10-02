import { describe, expect, it } from 'vitest';
import { variableForecastWindow } from '../src/services/variableForecast.service.js';
import { calculateBudgetFromInputs, sanitizePlanningForViewer } from '../src/modules/finance/finance.service.js';
import { withBusinessDate } from '../src/services/businessClock.service.js';
import { toIsoDate } from '../src/services/date.service.js';

const inputs = () => ({
  household: { timezone: 'Europe/Madrid', contributionMode: 'PERCENTAGE', safetyMarginBps: 1000,
    people: [{ id: 'own', name: 'Pablo', contributionBps: 10000, isActive: true }] },
  recurringExpenses: [], invoiceGroups: [], oneTimeExpenses: [],
  variableGroups: [{ categoryId: 'food', scope: 'HOUSEHOLD', applySafetyMargin: true, months: [
    { year: 2026, month: 9, entryMode: 'SUMMARY', summaryAmountCents: 40000 },
    { year: 2026, month: 10, entryMode: 'SUMMARY', summaryAmountCents: 60000 },
  ] }],
});
const calculate = (today, date = '2026-11-01', data = inputs()) =>
  withBusinessDate(today, () => calculateBudgetFromInputs(data, date));

describe('variable forecast estimated month closing', () => {
  it.each([
    ['2026-10-27', '2026-11-01', null],
    ['2026-10-28', '2026-11-01', '2026-10'],
    ['2026-10-29', '2026-11-01', '2026-10'],
    ['2026-10-31', '2026-11-01', '2026-10'],
    ['2026-04-26', '2026-05-01', null],
    ['2026-04-27', '2026-05-01', '2026-04'],
    ['2026-02-24', '2026-03-01', null],
    ['2026-02-25', '2026-03-01', '2026-02'],
    ['2028-02-26', '2028-03-01', '2028-02'],
    ['2026-12-28', '2027-01-01', '2026-12'],
    ['2026-10-29', '2026-10-01', null],
    ['2026-10-29', '2026-09-01', null],
    ['2026-11-01', '2026-11-01', null],
  ])('as of %s forecasting %s uses provisional month %s', (today, target, expected) => {
    const result = variableForecastWindow(target, today);
    expect(result.estimatedClosingMonth).toBe(expected);
    if (expected) expect(toIsoDate(result.historyDate)).toBe(target);
  });

  it('averages 400 and 600 as 500, then adds the margin only once, without changing actual spending', () => {
    const data = inputs();
    const original = structuredClone(data);
    const before = calculate('2026-10-27', undefined, data);
    const close = calculate('2026-10-29', undefined, data);
    expect(before.lines[0]).toMatchObject({ baseCents: 40000, amountCents: 44000, estimatedClosingMonth: null });
    expect(close.lines[0]).toMatchObject({ baseCents: 50000, amountCents: 55000, estimatedClosingMonth: '2026-10' });
    expect(data).toEqual(original);
    expect(calculate('2026-11-01', undefined, data).lines[0]).toMatchObject({ baseCents: 50000, amountCents: 55000, estimatedClosingMonth: null });
  });

  it('counts a known unpaid recurring bill separately, never inside or twice in the variable average', () => {
    const data = inputs();
    data.recurringExpenses.push({ id: 'internet', name: 'Factura día 30', scope: 'HOUSEHOLD', frequency: 'MONTHLY',
      amountCents: 8000, nextDueDate: '2026-10-30', safetyMarginOverrideBps: 0 });
    const result = calculate('2026-10-29', undefined, data);
    expect(result.lines.find((line) => line.type === 'VARIABLE').baseCents).toBe(50000);
    expect(result.lines.find((line) => line.type === 'RECURRING').amountCents).toBe(8000);
    expect(result.householdBudgetCents).toBe(63000);
    expect(result.lines).toHaveLength(2);
  });

  it('does not invent zero spending for a missing current month or include future months', () => {
    const data = inputs();
    data.variableGroups[0].months.splice(1, 1, { year: 2026, month: 11, entryMode: 'SUMMARY', summaryAmountCents: 99999 });
    const result = calculate('2026-10-29', '2027-01-01', data);
    expect(result.lines[0]).toMatchObject({ baseCents: 40000, estimatedClosingMonth: null });
  });

  it('uses detailed entries and preserves the last-three-month averaging rule', () => {
    const data = inputs();
    data.variableGroups[0].months = [
      { year: 2026, month: 7, entryMode: 'SUMMARY', summaryAmountCents: 90000 },
      { year: 2026, month: 8, entryMode: 'SUMMARY', summaryAmountCents: 50000 },
      { year: 2026, month: 9, entryMode: 'SUMMARY', summaryAmountCents: 40000 },
      { year: 2026, month: 10, entryMode: 'DETAIL', entries: [{ amountCents: 35000 }, { amountCents: 25000 }] },
    ];
    expect(calculate('2026-10-29', undefined, data).lines[0].baseCents).toBe(50000);
  });

  it('keeps the estimate label in saved visible lines without exposing foreign private estimates', () => {
    const result = sanitizePlanningForViewer({ householdBudgetCents: 55000, contributions: [], breakdown: {
      personIdentitySnapshot: [], budget: { lines: [
        ...calculate('2026-10-29').lines,
        { id: 'secret', type: 'VARIABLE', scope: 'PERSONAL', personalPersonId: 'other', estimatedClosingMonth: '2026-10' },
      ] },
    } }, 'viewer');
    expect(result.budgetLines).toHaveLength(1);
    expect(result.budgetLines[0].estimatedClosingMonth).toBe('2026-10');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
