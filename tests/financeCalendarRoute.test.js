import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';

const householdId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';

const authenticate = (request_, _response, next) => {
  request_.auth = { userId, sessionId: '10000000-0000-4000-8000-000000000003' };
  next();
};

const requireCsrf = (_request, _response, next) => next();

describe('finance calendar route', () => {
  it('loads archived recurring metadata so historical payments remain visible', async () => {
    const recurringExpense = {
      id: '10000000-0000-4000-8000-000000000004',
      householdId,
      name: 'Pago único archivado',
      amountCents: 8_000,
      scope: 'HOUSEHOLD',
      frequency: 'ONE_TIME',
      nextDueDate: new Date('2026-08-05T00:00:00.000Z'),
      isActive: false,
      archivedAt: new Date('2026-08-05T00:00:00.000Z'),
      category: { id: '10000000-0000-4000-8000-000000000005', name: 'Otros' },
      personalPerson: null,
    };
    const findManyExpenses = vi.fn().mockResolvedValue([recurringExpense]);
    const prisma = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          role: 'MEMBER',
          household: { id: householdId, isActive: true, ownerUserId: null },
        }),
      },
      recurringExpense: { findMany: findManyExpenses },
      expensePayment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '10000000-0000-4000-8000-000000000006',
            recurringExpenseId: recurringExpense.id,
            dueDate: new Date('2026-08-05T00:00:00.000Z'),
            expectedAmountCents: 8_000,
            actualAmountCents: 8_250,
            paymentDate: new Date('2026-08-05T00:00:00.000Z'),
            status: 'PAID',
          },
        ]),
      },
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createFinanceRouter({ prisma, authenticate, requireCsrf }),
    );
    app.use((error, _request, response, _next) => {
      response.status(error.statusCode ?? 500).json({
        success: false,
        code: error.code ?? 'INTERNAL_ERROR',
      });
    });

    const response = await request(app)
      .get(`/api/households/${householdId}/calendar`)
      .query({ view: 'YEAR', anchorDate: '2026-01-01' })
      .expect(200);

    expect(findManyExpenses).toHaveBeenCalledWith({
      where: { householdId },
      include: {
        category: true,
        personalPerson: { select: { id: true, name: true } },
      },
    });
    expect(response.body.data.events).toEqual([
      expect.objectContaining({
        expenseId: recurringExpense.id,
        dueDate: '2026-08-05',
        status: 'PAID',
        amountCents: 8_250,
      }),
    ]);
  });
});
