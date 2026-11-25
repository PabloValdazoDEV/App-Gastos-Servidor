import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';

const householdId = '30000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000002';
const categoryId = '30000000-0000-4000-8000-000000000003';
const scheduleId = '30000000-0000-4000-8000-000000000004';

const authenticate = (request_, _response, next) => {
  request_.auth = { userId, sessionId: '30000000-0000-4000-8000-000000000005' };
  next();
};
const requireCsrf = (_request, _response, next) => next();

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({ prisma, authenticate, requireCsrf }));
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? (error.name === 'ZodError' ? 400 : 500)).json({ success: false, code: error.code ?? error.name, message: error.message });
  });
  return app;
}

const schedule = (overrides = {}) => ({
  id: scheduleId, householdId, categoryId, personalPersonId: null, name: 'Luz', scope: 'HOUSEHOLD',
  frequency: 'BIMONTHLY', intervalMonths: null, intervalWeeks: null, usualDayOfMonth: 10,
  nextExpectedDate: new Date('2027-01-10T00:00:00.000Z'), endDate: null, isActive: true,
  category: { id: categoryId, name: 'Luz' }, personalPerson: null, ...overrides,
});

describe('facturas periódicas', () => {
  let prisma;
  beforeEach(() => {
    prisma = {
      householdUserAccess: { findFirst: vi.fn().mockResolvedValue({ role: 'MEMBER', household: { id: householdId, isActive: true, ownerUserId: null } }) },
      category: { findFirst: vi.fn().mockResolvedValue({ id: categoryId, householdId }) },
      invoiceSchedule: {
        findMany: vi.fn().mockResolvedValue([schedule()]),
        findFirst: vi.fn().mockResolvedValue(schedule()),
        create: vi.fn(async ({ data }) => ({ id: scheduleId, ...data })),
        update: vi.fn(async ({ data }) => ({ ...schedule(), ...data })),
        delete: vi.fn(),
      },
      utilityInvoice: {
        findMany: vi.fn().mockResolvedValue([
          { scheduleId, categoryId, scope: 'HOUSEHOLD', personalPersonId: null, invoiceDate: new Date('2026-11-10T00:00:00.000Z'), amountCents: 7_810 },
          { scheduleId, categoryId, scope: 'HOUSEHOLD', personalPersonId: null, invoiceDate: new Date('2026-09-10T00:00:00.000Z'), amountCents: 9_240 },
        ]),
        create: vi.fn(async ({ data }) => ({ id: 'invoice-1', ...data })),
      },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (callback) => callback(prisma)),
    };
  });

  it('crea una factura bimestral hacia el día 10 y rechaza un «pago único»', async () => {
    const app = buildApp(prisma);
    const body = { categoryId, name: 'Luz', frequency: 'BIMONTHLY', nextExpectedDate: '2027-01-10' };
    await request(app).post(`/api/households/${householdId}/invoice-schedules`).send(body).expect(201);
    expect(prisma.invoiceSchedule.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ householdId, frequency: 'BIMONTHLY', usualDayOfMonth: 10, intervalMonths: null, endDate: null }),
    }));

    const rejected = await request(app).post(`/api/households/${householdId}/invoice-schedules`).send({ ...body, frequency: 'ONE_TIME' });
    expect(rejected.status).toBe(400);
  });

  it('lista cada factura periódica con su importe estimado y las próximas fechas', async () => {
    const response = await request(buildApp(prisma)).get(`/api/households/${householdId}/invoice-schedules`);
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      name: 'Luz',
      estimate: { amountCents: 8_525, basedOn: 2, source: 'SCHEDULE' },
      upcomingDates: ['2027-01-10', '2027-03-10', '2027-05-10'],
    });
  });

  it('apuntar la factura real desde la periódica la enlaza y mueve la siguiente fecha', async () => {
    await request(buildApp(prisma))
      .post(`/api/households/${householdId}/invoices`)
      .send({ categoryId, amountCents: 8_100, scheduleId, periodStart: '2026-11-10', periodEnd: '2027-01-09', invoiceDate: '2027-01-08' })
      .expect(201);
    expect(prisma.utilityInvoice.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scheduleId }) }));
    expect(prisma.invoiceSchedule.update).toHaveBeenCalledWith({
      where: { id: scheduleId },
      data: { nextExpectedDate: new Date('2027-03-10T00:00:00.000Z') },
    });
  });

  it('las rutas de facturas periódicas exigen sesión', async () => {
    const app = express();
    app.use(express.json());
    const reject = (_request, response) => response.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
    app.use('/api', createFinanceRouter({ prisma, authenticate: reject, requireCsrf }));
    await request(app).get(`/api/households/${householdId}/invoice-schedules`).expect(401);
    await request(app).delete(`/api/households/${householdId}/invoice-schedules/${scheduleId}`).expect(401);
    expect(prisma.invoiceSchedule.findMany).not.toHaveBeenCalled();
    expect(prisma.invoiceSchedule.delete).not.toHaveBeenCalled();
  });

  it('no enlaza una factura a una periódica que no es visible', async () => {
    prisma.invoiceSchedule.findFirst.mockResolvedValue(null);
    const response = await request(buildApp(prisma))
      .post(`/api/households/${householdId}/invoices`)
      .send({ categoryId, amountCents: 8_100, scheduleId, periodStart: '2026-11-10', periodEnd: '2027-01-09', invoiceDate: '2027-01-08' })
      .expect(404);
    expect(response.body.code).toBe('INVOICE_SCHEDULE_NOT_FOUND');
    expect(prisma.utilityInvoice.create).not.toHaveBeenCalled();
  });
});
