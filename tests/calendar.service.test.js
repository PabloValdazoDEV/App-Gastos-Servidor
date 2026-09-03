import { describe, expect, it } from 'vitest';

import { buildCalendar } from '../src/services/calendar.service.js';

describe('calendar.service', () => {
  it('distingue próximos, vencidos, pagados y omitidos', () => {
    const expenses = [
      {
        id: 'paid',
        name: 'Pagado',
        amountCents: 100,
        scope: 'HOUSEHOLD',
        nextDueDate: '2026-08-10',
        isActive: true,
      },
      {
        id: 'due',
        name: 'Hoy',
        amountCents: 200,
        scope: 'PERSONAL',
        personalPersonId: 'a',
        nextDueDate: '2026-08-15',
        isActive: true,
      },
      {
        id: 'upcoming',
        name: 'Próximo',
        amountCents: 300,
        scope: 'HOUSEHOLD',
        nextDueDate: '2026-08-20',
        isActive: true,
      },
    ];
    const calendar = buildCalendar({
      recurringExpenses: expenses,
      payments: [
        {
          recurringExpenseId: 'paid',
          dueDate: '2026-08-10',
          status: 'PAID',
        },
      ],
      today: '2026-08-15',
      anchorDate: '2026-08-01',
      view: 'MONTH',
    });

    expect(calendar.events.map(({ expenseId, status }) => [expenseId, status])).toEqual([
      ['paid', 'PAID'],
      ['due', 'DUE'],
      ['upcoming', 'UPCOMING'],
    ]);
  });

  it('expande los vencimientos recurrentes dentro del rango elegido', () => {
    const calendar = buildCalendar({
      recurringExpenses: [
        {
          id: 'monthly',
          name: 'Servidor',
          amountCents: 1800,
          scope: 'HOUSEHOLD',
          frequency: 'MONTHLY',
          nextDueDate: '2026-08-05',
          isActive: true,
        },
      ],
      today: '2026-08-01',
      anchorDate: '2026-08-01',
      view: '90_DAYS',
    });

    expect(calendar.events.map((event) => event.dueDate)).toEqual([
      '2026-08-05',
      '2026-09-05',
      '2026-10-05',
    ]);
  });

  it('conserva pagos históricos tras avanzar o archivar el recurrente', () => {
    const calendar = buildCalendar({
      recurringExpenses: [
        {
          id: 'monthly',
          name: 'Servidor',
          amountCents: 2_000,
          scope: 'HOUSEHOLD',
          frequency: 'MONTHLY',
          nextDueDate: '2026-09-10',
          isActive: true,
        },
        {
          id: 'one-time',
          name: 'Instalación',
          amountCents: 8_000,
          scope: 'HOUSEHOLD',
          frequency: 'ONE_TIME',
          nextDueDate: '2026-08-05',
          isActive: false,
          archivedAt: '2026-08-05',
        },
      ],
      payments: [
        {
          id: 'payment-monthly',
          recurringExpenseId: 'monthly',
          dueDate: '2026-08-10',
          expectedAmountCents: 2_000,
          actualAmountCents: 2_250,
          paymentDate: '2026-08-09',
          status: 'PAID',
        },
        {
          id: 'payment-one-time',
          recurringExpenseId: 'one-time',
          dueDate: '2026-08-05',
          expectedAmountCents: 8_000,
          actualAmountCents: null,
          paymentDate: null,
          status: 'SKIPPED',
        },
      ],
      today: '2026-08-15',
      anchorDate: '2026-08-01',
      view: '90_DAYS',
    });

    expect(calendar.events.slice(0, 4)).toEqual([
      expect.objectContaining({
        expenseId: 'one-time',
        paymentId: 'payment-one-time',
        dueDate: '2026-08-05',
        amountCents: 8_000,
        status: 'SKIPPED',
      }),
      expect.objectContaining({
        expenseId: 'monthly',
        paymentId: 'payment-monthly',
        dueDate: '2026-08-10',
        amountCents: 2_250,
        status: 'PAID',
      }),
      expect.objectContaining({
        expenseId: 'monthly',
        dueDate: '2026-09-10',
        status: 'UPCOMING',
      }),
      expect.objectContaining({
        expenseId: 'monthly',
        dueDate: '2026-10-10',
        status: 'UPCOMING',
      }),
    ]);
  });

  it('fusiona un pago con su ocurrencia programada sin duplicarla', () => {
    const calendar = buildCalendar({
      recurringExpenses: [
        {
          id: 'expense',
          name: 'Seguro',
          amountCents: 90_000,
          scope: 'HOUSEHOLD',
          frequency: 'YEARLY',
          nextDueDate: '2026-11-02',
          isActive: true,
        },
      ],
      payments: [
        {
          id: 'future-payment',
          recurringExpenseId: 'expense',
          dueDate: '2026-11-02',
          expectedAmountCents: 90_000,
          actualAmountCents: 92_000,
          paymentDate: '2026-10-30',
          status: 'PAID',
        },
      ],
      today: '2026-08-15',
      anchorDate: '2026-01-01',
      view: 'YEAR',
    });

    expect(calendar.events).toHaveLength(1);
    expect(calendar.events[0]).toMatchObject({
      expenseId: 'expense',
      dueDate: '2026-11-02',
      status: 'PAID',
      amountCents: 92_000,
    });
  });
});
