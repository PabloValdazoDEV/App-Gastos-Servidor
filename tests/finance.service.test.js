import { describe, expect, it } from 'vitest';

import { dashboardDuePayments } from '../src/modules/finance/finance.service.js';

describe('dashboardDuePayments', () => {
  it('puts overdue payments first and excludes dates more than five days ahead', () => {
    const payments = dashboardDuePayments(
      [
        {
          id: 'late',
          name: 'Alquiler',
          amountCents: 90_000,
          nextDueDate: '2026-08-20',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'today',
          name: 'Internet',
          amountCents: 5_000,
          nextDueDate: '2026-08-26',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'near',
          name: 'Luz',
          amountCents: 8_000,
          nextDueDate: '2026-08-31',
          scope: 'HOUSEHOLD',
        },
        {
          id: 'far',
          name: 'Seguro',
          amountCents: 12_000,
          nextDueDate: '2026-09-26',
          scope: 'HOUSEHOLD',
        },
      ],
      '2026-08-26',
    );

    expect(payments.map((payment) => payment.expenseId)).toEqual(['late', 'today', 'near']);
  });
});
