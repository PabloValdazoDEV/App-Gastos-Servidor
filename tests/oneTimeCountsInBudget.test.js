import { describe, expect, it, vi } from 'vitest';

import { createOneTimeExpenseSchema, updateOneTimeExpenseSchema } from '../src/modules/finance/finance.schemas.js';
import { loadFinancialInputs } from '../src/modules/finance/finance.service.js';

const base = { categoryId: '40000000-0000-4000-8000-000000000001', name: 'Reparación', amountCents: 30_000, expenseDate: '2026-12-10' };

describe('gasto puntual: contar en la previsión', () => {
  it('por defecto cuenta; se puede crear sin contar; editar otro dato no lo vuelve a marcar', () => {
    expect(createOneTimeExpenseSchema.parse(base).countsInBudget).toBe(true);
    expect(createOneTimeExpenseSchema.parse({ ...base, countsInBudget: false }).countsInBudget).toBe(false);
    expect(updateOneTimeExpenseSchema.parse({ name: 'Otra' })).not.toHaveProperty('countsInBudget');
    expect(updateOneTimeExpenseSchema.parse({ countsInBudget: false }).countsInBudget).toBe(false);
  });

  it('los cálculos solo cargan los gastos puntuales que cuentan', async () => {
    const empty = () => ({ findMany: vi.fn().mockResolvedValue([]) });
    const database = {
      household: { findUnique: vi.fn().mockResolvedValue({ id: 'h1', people: [], safetyMarginBps: 0 }) },
      recurringExpense: empty(), utilityInvoice: empty(), variableExpenseMonth: empty(), oneTimeExpense: empty(),
      budgetMarginPreference: empty(),
    };
    await loadFinancialInputs(database, 'h1', 'u1', new Date('2026-12-01T00:00:00.000Z'));
    expect(database.oneTimeExpense.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ householdId: 'h1', countsInBudget: true }),
    }));
  });
});
