import { describe, expect, it } from 'vitest';

import { buildCalendar } from '../src/services/calendar.service.js';

describe('calendar.service', () => {
  const currentExpense = {
    id: 'gym', name: 'Gimnasio', amountCents: 4000, scope: 'HOUSEHOLD',
    frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, nextDueDate: '2026-10-15',
    isActive: true, archivedAt: null,
  };

  it.each(['MONTH', '30_DAYS', '90_DAYS', 'YEAR'])(
    'el backend solo habilita la ocurrencia actual en vista %s', (view) => {
      const calendar = buildCalendar({
        recurringExpenses: [currentExpense], today: '2026-10-01',
        anchorDate: '2026-10-01', view,
      });
      expect(calendar.events[0]).toMatchObject({
        expenseId: 'gym', dueDate: '2026-10-15', canRegisterPayment: true,
        canEditPayment: false, paymentId: null, expectedAmountCents: 4000,
        actualAmountCents: null, paymentDate: null, notes: null,
      });
      calendar.events.slice(1).forEach((event) => {
        expect(event.canRegisterPayment).toBe(false);
        expect(event.canEditPayment).toBe(false);
      });
    },
  );

  it.each([
    ['2026-10-17', 'OVERDUE'], ['2026-10-15', 'DUE'], ['2026-10-01', 'UPCOMING'],
  ])('el actual es registrable con hoy %s aunque sea %s', (today, status) => {
    const calendar = buildCalendar({
      recurringExpenses: [currentExpense], today, anchorDate: '2026-10-01', view: 'MONTH',
    });
    expect(calendar.events[0]).toMatchObject({ status, canRegisterPayment: true });
  });

  it('un rango posterior a la ocurrencia pendiente no habilita su primera tarjeta', () => {
    const calendar = buildCalendar({
      recurringExpenses: [currentExpense], today: '2026-11-01',
      anchorDate: '2026-11-01', view: '90_DAYS',
    });
    expect(calendar.events[0].dueDate).toBe('2026-11-12');
    expect(calendar.events.every((event) => !event.canRegisterPayment)).toBe(true);
  });

  it.each(['PAID', 'SKIPPED'])('el histórico %s tiene identificador y corrección, incluso archivado', (status) => {
    const calendar = buildCalendar({
      recurringExpenses: [{ ...currentExpense, isActive: false, archivedAt: '2026-10-16' }],
      payments: [{
        id: 'payment', recurringExpenseId: 'gym', dueDate: '2026-10-15', status,
        expectedAmountCents: 4000, actualAmountCents: status === 'PAID' ? 4200 : null,
        paymentDate: status === 'PAID' ? '2026-10-17' : null, notes: 'Nota original',
      }],
      today: '2026-10-17', anchorDate: '2026-10-01', view: 'MONTH',
    });
    expect(calendar.events).toHaveLength(1);
    expect(calendar.events[0]).toMatchObject({
      paymentId: 'payment', status, canRegisterPayment: false, canEditPayment: true,
      notes: 'Nota original', expectedAmountCents: 4000,
      actualAmountCents: status === 'PAID' ? 4200 : null,
      paymentDate: status === 'PAID' ? '2026-10-17' : null,
    });
  });

  it('no ofrece edición si el registro recibido carece de paymentId', () => {
    const calendar = buildCalendar({
      recurringExpenses: [currentExpense],
      payments: [{ recurringExpenseId: 'gym', dueDate: '2026-10-15', status: 'PAID' }],
      today: '2026-10-01', view: 'MONTH',
    });
    expect(calendar.events[0]).toMatchObject({ paymentId: null, canRegisterPayment: false, canEditPayment: false });
  });

  it.each([{ isActive: false }, { archivedAt: '2026-10-01' }])('no programa gastos inactivos/archivados %j', (overrides) => {
    expect(buildCalendar({ recurringExpenses: [{ ...currentExpense, ...overrides }], today: '2026-10-01', view: 'MONTH' }).events).toEqual([]);
  });

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
