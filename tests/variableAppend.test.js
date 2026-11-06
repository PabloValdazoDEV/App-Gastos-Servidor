import { describe, expect, it, vi } from 'vitest';

import { appendToVariableMonth, buildAppendedEntries } from '../src/modules/finance/variableAppend.js';

const d = (value) => new Date(`${value}T00:00:00.000Z`);

describe('añadir a un mes de gastos variables existente', () => {
  it('conserva los 5 tickets ya apuntados y añade el nuevo', async () => {
    const existing = { id: 'month-1', year: 2026, month: 11, entryMode: 'DETAIL', summaryAmountCents: null };
    const database = {
      variableExpenseMonth: { update: vi.fn() },
      variableExpenseEntry: { createMany: vi.fn(), deleteMany: vi.fn() },
    };

    await appendToVariableMonth(database, existing, {
      entryMode: 'DETAIL',
      entries: [{ spentOn: d('2026-11-06'), amountCents: 5_420, paymentDate: d('2026-11-06') }],
    });

    expect(database.variableExpenseEntry.deleteMany).not.toHaveBeenCalled();
    expect(database.variableExpenseMonth.update).not.toHaveBeenCalled();
    expect(database.variableExpenseEntry.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ variableExpenseMonthId: 'month-1', amountCents: 5_420 })],
    });
  });

  it('convierte un total mensual previo en un apunte y suma el nuevo importe', () => {
    const existing = {
      year: 2026, month: 11, entryMode: 'SUMMARY', summaryAmountCents: 30_000, paidAt: d('2026-11-03'),
    };
    const entries = buildAppendedEntries(existing, {
      entryMode: 'SUMMARY', summaryAmountCents: 5_420, paymentDate: d('2026-11-06'),
    });

    expect(entries).toEqual([
      expect.objectContaining({ amountCents: 30_000, notes: 'Total anterior', spentOn: d('2026-11-01'), paidAt: d('2026-11-03') }),
      expect.objectContaining({ amountCents: 5_420, spentOn: d('2026-11-06'), paidAt: d('2026-11-06') }),
    ]);
    expect(entries.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(35_420);
  });

  it('fecha el nuevo total en el día 1 si se pagó fuera de ese mes', () => {
    const [entry] = buildAppendedEntries(
      { year: 2026, month: 10, entryMode: 'DETAIL' },
      { entryMode: 'SUMMARY', summaryAmountCents: 1_000, paymentDate: d('2026-11-06') },
    );
    expect(entry.spentOn).toEqual(d('2026-10-01'));
  });

  it('pasa el mes a modo detallado antes de insertar apuntes', async () => {
    const calls = [];
    const database = {
      variableExpenseMonth: { update: vi.fn(async () => { calls.push('update'); return { id: 'month-1' }; }) },
      variableExpenseEntry: { createMany: vi.fn(async () => { calls.push('createMany'); }) },
    };
    await appendToVariableMonth(
      database,
      { id: 'month-1', year: 2026, month: 11, entryMode: 'SUMMARY', summaryAmountCents: 30_000 },
      { entryMode: 'SUMMARY', summaryAmountCents: 5_420 },
    );
    expect(calls).toEqual(['update', 'createMany']);
    expect(database.variableExpenseMonth.update).toHaveBeenCalledWith({
      where: { id: 'month-1' },
      data: { entryMode: 'DETAIL', summaryAmountCents: null, paidAt: null },
    });
  });
});
