import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';

const householdId = '20000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const personId = '20000000-0000-4000-8000-000000000003';

const authenticate = (request_, _response, next) => {
  request_.auth = { userId, sessionId: '20000000-0000-4000-8000-000000000004' };
  next();
};

const requireCsrf = (_request, _response, next) => next();

describe('finance recovery route', () => {
  it('feeds the standard household contribution and real due dates into RECOMMENDED', async () => {
    const household = {
      id: householdId,
      name: 'Casa',
      currentBalanceCents: 0,
      safetyMarginBps: 0,
      contributionMode: 'PERCENTAGE',
      people: [
        {
          id: personId,
          name: 'Persona',
          contributionBps: 10_000,
          isActive: true,
          archivedAt: null,
        },
      ],
    };
    const recurringExpenses = [
      {
        id: '20000000-0000-4000-8000-000000000005',
        householdId,
        name: 'Mensual',
        amountCents: 10_000,
        scope: 'HOUSEHOLD',
        frequency: 'MONTHLY',
        intervalMonths: null,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        nextDueDate: new Date('2026-02-20T00:00:00.000Z'),
        isActive: true,
        archivedAt: null,
        safetyMarginOverrideBps: null,
        category: { safetyMarginBps: null },
        personalPerson: null,
      },
      {
        id: '20000000-0000-4000-8000-000000000006',
        householdId,
        name: 'Pago único',
        amountCents: 60_000,
        scope: 'HOUSEHOLD',
        frequency: 'ONE_TIME',
        intervalMonths: null,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        nextDueDate: new Date('2026-02-20T00:00:00.000Z'),
        isActive: true,
        archivedAt: null,
        safetyMarginOverrideBps: null,
        category: { safetyMarginBps: null },
        personalPerson: null,
      },
    ];
    const prisma = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          role: 'MEMBER',
          household: { id: householdId, isActive: true, ownerUserId: null },
        }),
      },
      household: { findUnique: vi.fn().mockResolvedValue(household) },
      recurringExpense: { findMany: vi.fn().mockResolvedValue(recurringExpenses) },
      utilityInvoice: { findMany: vi.fn().mockResolvedValue([]) },
      variableExpenseMonth: { findMany: vi.fn().mockResolvedValue([]) },
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
        message: error.message,
      });
    });

    const response = await request(app)
      .post(`/api/households/${householdId}/recovery-plans/preview`)
      .send({
        deficitCents: 120_000,
        mode: 'RECOMMENDED',
        startsOn: '2026-01-15',
      })
      .expect(200);

    expect(response.body.data).toMatchObject({
      monthlyAdjustmentCents: 25_000,
      estimatedMonths: 5,
      recommendation: {
        standardMonthlyBudgetCents: 10_000,
        cashFlowMinimumCents: 25_000,
        limitingDueDate: '2026-02-20',
        limitingMonthsAvailable: 2,
      },
      distribution: [
        { personId, temporaryAdjustmentCents: 25_000 },
      ],
    });
  });
});
