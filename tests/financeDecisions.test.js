import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import {
  editPaymentSchema,
  registerPaymentSchema,
  upsertVariableMonthSchema,
} from '../src/modules/finance/finance.schemas.js';
import { createFinanceRouter } from '../src/modules/finance/index.js';

const householdId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const expenseId = '10000000-0000-4000-8000-000000000003';
const categoryId = '10000000-0000-4000-8000-000000000004';
const invoiceId = '10000000-0000-4000-8000-000000000005';
const paymentId = '10000000-0000-4000-8000-000000000006';

const authenticate = (request_, _response, next) => {
  request_.auth = { userId, sessionId: crypto.randomUUID() };
  next();
};

const requireCsrf = (_request, _response, next) => next();

const createPaymentFixture = () => {
  const recurringExpense = {
    id: expenseId,
    householdId,
    amountCents: 90_499,
    nextDueDate: new Date('2026-11-02T00:00:00.000Z'),
    frequency: 'YEARLY',
    intervalMonths: null,
    archivedAt: null,
    isActive: true,
  };
  const database = {
    recurringExpense: {
      findFirst: vi.fn().mockResolvedValue(recurringExpense),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...recurringExpense, ...data }),
      ),
    },
    expensePayment: {
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: crypto.randomUUID(), ...data }),
      ),
      findFirst: vi.fn().mockResolvedValue({
        id: paymentId,
        recurringExpenseId: expenseId,
        status: 'PAID',
      }),
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: paymentId,
          recurringExpenseId: expenseId,
          ...data,
        }),
      ),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }) },
  };
  const prisma = {
    ...database,
    householdUserAccess: {
      findFirst: vi.fn().mockResolvedValue({
        role: 'MEMBER',
        household: { id: householdId, isActive: true, ownerUserId: null },
      }),
    },
    $transaction: vi.fn((operation) => operation(database)),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createFinanceRouter({ prisma, authenticate, requireCsrf }),
  );
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? 400).json({
      success: false,
      code: error.code ?? 'VALIDATION_ERROR',
      message: error.message,
    });
  });

  return { app, database };
};

const createInvoiceFixture = () => {
  const invoice = {
    id: invoiceId,
    householdId,
    categoryId,
    amountCents: 7_200,
    periodStart: new Date('2026-07-16T00:00:00.000Z'),
    periodEnd: new Date('2026-08-15T00:00:00.000Z'),
    invoiceDate: new Date('2026-08-20T00:00:00.000Z'),
    chargeDate: null,
    notes: null,
    category: { id: categoryId, name: 'Luz' },
  };
  const database = {
    utilityInvoice: {
      update: vi.fn(({ data }) => Promise.resolve({ ...invoice, ...data })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }) },
  };
  const prisma = {
    ...database,
    householdUserAccess: {
      findFirst: vi.fn().mockResolvedValue({
        role: 'MEMBER',
        household: { id: householdId, isActive: true, ownerUserId: null },
      }),
    },
    utilityInvoice: {
      findFirst: vi.fn().mockResolvedValue(invoice),
      ...database.utilityInvoice,
    },
    $transaction: vi.fn((operation) => operation(database)),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({ prisma, authenticate, requireCsrf }));
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? 400).json({
      success: false,
      code: error.code ?? 'VALIDATION_ERROR',
      message: error.message,
    });
  });

  return { app, database, prisma };
};

describe('financial input decisions', () => {
  it('uses the real paid amount as the next expected amount only when requested', async () => {
    const { app, database } = createPaymentFixture();
    const response = await request(app)
      .post(
        `/api/households/${householdId}/recurring-expenses/${expenseId}/payments`,
      )
      .send({
        status: 'PAID',
        actualAmountCents: 93_250,
        nextAmountDecision: 'UPDATE_NEXT_AMOUNT',
      })
      .expect(201);

    expect(response.body.data.recurringExpense.amountCents).toBe(93_250);
    expect(database.expensePayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actualAmountCents: 93_250,
        nextAmountDecision: 'UPDATE_NEXT_AMOUNT',
        nextExpectedAmountCents: 93_250,
      }),
    });
    expect(database.recurringExpense.update).toHaveBeenCalledWith({
      where: { id: expenseId },
      data: expect.objectContaining({ amountCents: 93_250 }),
    });
  });

  it('rejects incompatible next-amount decisions before persistence', () => {
    expect(() =>
      registerPaymentSchema.parse({
        status: 'SKIPPED',
        nextAmountDecision: 'UPDATE_NEXT_AMOUNT',
        nextExpectedAmountCents: 93_250,
      }),
    ).toThrow();
    expect(() =>
      registerPaymentSchema.parse({
        status: 'SKIPPED',
        actualAmountCents: 93_250,
        nextAmountDecision: 'KEEP_PREVIOUS',
      }),
    ).toThrow();
    expect(() =>
      registerPaymentSchema.parse({
        status: 'PAID',
        actualAmountCents: 93_250,
        nextAmountDecision: 'KEEP_PREVIOUS',
        nextExpectedAmountCents: 94_000,
      }),
    ).toThrow();
    expect(() =>
      registerPaymentSchema.parse({
        status: 'PAID',
        actualAmountCents: 93_250,
        nextAmountDecision: 'UPDATE_NEXT_AMOUNT',
        nextExpectedAmountCents: 94_000,
      }),
    ).toThrow();
  });

  it('edits a historical payment without changing the recurring expense', async () => {
    const { app, database } = createPaymentFixture();
    const response = await request(app)
      .patch(
        `/api/households/${householdId}/recurring-expenses/${expenseId}/payments/${paymentId}`,
      )
      .send({
        status: 'PAID',
        actualAmountCents: 88_400,
        paymentDate: '2026-11-01',
        notes: 'Importe corregido',
      })
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: paymentId,
      actualAmountCents: 88_400,
      notes: 'Importe corregido',
      status: 'PAID',
    });
    expect(database.expensePayment.update).toHaveBeenCalledWith({
      where: { id: paymentId },
      data: {
        actualAmountCents: 88_400,
        notes: 'Importe corregido',
        paymentDate: expect.any(Date),
        status: 'PAID',
      },
    });
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
    expect(database.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'EXPENSE_CHANGED',
        resourceId: paymentId,
        resourceType: 'ExpensePayment',
      }),
    });
  });

  it('requires an amount and date when a corrected payment is marked as paid', () => {
    expect(() =>
      editPaymentSchema.parse({
        status: 'PAID',
        actualAmountCents: null,
        paymentDate: null,
      }),
    ).toThrow();
  });

  it('enforces exclusive SUMMARY and DETAIL variable-month shapes', () => {
    const base = {
      categoryId,
      scope: 'HOUSEHOLD',
      year: 2026,
      month: 8,
    };

    expect(() =>
      upsertVariableMonthSchema.parse({ ...base, entryMode: 'SUMMARY' }),
    ).toThrow();
    expect(() =>
      upsertVariableMonthSchema.parse({
        ...base,
        entryMode: 'SUMMARY',
        summaryAmountCents: 42_315,
        entries: [
          {
            spentOn: '2026-08-10',
            amountCents: 1_000,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      upsertVariableMonthSchema.parse({
        ...base,
        entryMode: 'DETAIL',
        summaryAmountCents: 42_315,
      }),
    ).toThrow();

    const detail = upsertVariableMonthSchema.parse({
      ...base,
      entryMode: 'DETAIL',
      entries: [{ spentOn: '2026-08-10', amountCents: 1_000 }],
    });
    expect(detail.entryMode).toBe('DETAIL');
    expect(detail).not.toHaveProperty('summaryAmountCents');
  });

  it('updates a historical invoice atomically and records the change', async () => {
    const { app, database, prisma } = createInvoiceFixture();
    const response = await request(app)
      .patch(`/api/households/${householdId}/invoices/${invoiceId}`)
      .send({ amountCents: 8_050, notes: 'Lectura corregida' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      id: invoiceId,
      amountCents: 8_050,
      notes: 'Lectura corregida',
    });
    expect(database.utilityInvoice.update).toHaveBeenCalledWith({
      where: { id: invoiceId },
      data: { amountCents: 8_050, notes: 'Lectura corregida' },
      include: { category: true },
    });
    expect(database.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: userId,
        householdId,
        action: 'EXPENSE_CHANGED',
        resourceType: 'UtilityInvoice',
        resourceId: invoiceId,
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('rejects an edited period whose end would precede its start', async () => {
    const { app, database } = createInvoiceFixture();
    const response = await request(app)
      .patch(`/api/households/${householdId}/invoices/${invoiceId}`)
      .send({ periodStart: '2026-08-16' })
      .expect(400);

    expect(response.body.code).toBe('INVALID_INVOICE_PERIOD');
    expect(database.utilityInvoice.update).not.toHaveBeenCalled();
  });
});
