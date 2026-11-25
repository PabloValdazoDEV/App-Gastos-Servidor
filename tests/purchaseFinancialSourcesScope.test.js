import { describe, expect, it, vi } from 'vitest';

import { loadPurchaseFinancialSources } from '../src/modules/finance/purchaseFinancialSources.js';

describe('compras en los cálculos', () => {
  it('una compra al contado es solo ticket y garantía: no se consulta como gasto del mes', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadPurchaseFinancialSources({ purchase: { findMany }, householdPerson: { findMany: vi.fn().mockResolvedValue([]) } }, {
      householdId: 'h1', actorUserId: 'u1', from: '2026-11-01', to: '2026-11-30',
    });
    const { OR } = findMany.mock.calls[0][0].where;
    expect(OR.some((clause) => clause.paymentMethod === 'UPFRONT')).toBe(false);
    // Legacy financed purchases still bring their installments.
    expect(OR.every((clause) => clause.paymentMethod === 'FINANCED')).toBe(true);
  });
});
