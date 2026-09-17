import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createFinanceRouter } from '../src/modules/finance/index.js';
import { createRecurringExpenseSchema, recurringIntervalsSchema, updateRecurringExpenseSchema } from '../src/modules/finance/finance.schemas.js';

const householdId = '30000000-0000-4000-8000-000000000001';
const categoryId = '30000000-0000-4000-8000-000000000002';
const expenseId = '30000000-0000-4000-8000-000000000003';
const userId = '30000000-0000-4000-8000-000000000004';
const path = `/api/households/${householdId}/recurring-expenses`;
const creation = {
  name: 'Gimnasio', categoryId, amountCents: 4000, scope: 'HOUSEHOLD',
  frequency: 'CUSTOM_WEEKS', intervalWeeks: 4,
  startDate: '2026-09-17', nextDueDate: '2026-09-17',
};

function fixture(overrides = {}) {
  const state = {
    expense: {
      ...creation, id: expenseId, householdId, intervalMonths: null,
      startDate: new Date(creation.startDate), nextDueDate: new Date(creation.nextDueDate),
      isActive: true, archivedAt: null, usualDayOfMonth: null,
      personalPersonId: null, category: { id: categoryId, safetyMarginBps: null },
      ...overrides,
    },
    payments: [],
  };
  const database = {
    householdUserAccess: { findFirst: vi.fn().mockResolvedValue({ role: 'MEMBER', household: { id: householdId, isActive: true } }) },
    category: { findFirst: vi.fn().mockResolvedValue({ id: categoryId, householdId }) },
    recurringExpense: {
      findMany: vi.fn(async () => [state.expense]),
      findFirst: vi.fn(async () => state.expense),
      create: vi.fn(async ({ data }) => { state.expense = { id: expenseId, ...data }; return state.expense; }),
      update: vi.fn(async ({ data }) => { state.expense = { ...state.expense, ...data }; return state.expense; }),
    },
    expensePayment: {
      findUnique: vi.fn(async ({ where }) => state.payments.find((payment) =>
        payment.recurringExpenseId === where.recurringExpenseId_dueDate.recurringExpenseId &&
        payment.dueDate.getTime() === where.recurringExpenseId_dueDate.dueDate.getTime(),
      ) ?? null),
      create: vi.fn(async ({ data }) => {
        const payment = { id: crypto.randomUUID(), ...data };
        state.payments.push(payment);
        return payment;
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  database.$transaction = vi.fn((operation) => operation(database));
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({
    prisma: database,
    authenticate: (req, _res, next) => { req.auth = { userId }; next(); },
    requireCsrf: (_req, _res, next) => next(),
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 400).json({ code: error.code ?? 'VALIDATION_ERROR', details: error.issues }));
  return { app, database, state };
}

describe('schemas de intervalos recurrentes', () => {
  it.each([undefined, null, 0, 1, -2, 2.5, 521, '4'])('CUSTOM_WEEKS rechaza intervalo %s', (intervalWeeks) => {
    const result = createRecurringExpenseSchema.safeParse({ ...creation, intervalWeeks });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.path[0] === 'intervalWeeks')).toBe(true);
  });

  it.each([2, 3, 4, 5, 520])('acepta %s semanas enteras', (intervalWeeks) => {
    expect(createRecurringExpenseSchema.parse({ ...creation, intervalWeeks })).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks, intervalMonths: null });
  });

  it('normaliza incompatibles y conserva WEEKLY y CUSTOM_MONTHS', () => {
    expect(createRecurringExpenseSchema.parse({ ...creation, frequency: 'WEEKLY', intervalWeeks: undefined })).toMatchObject({ intervalWeeks: null, intervalMonths: null });
    expect(createRecurringExpenseSchema.parse({ ...creation, frequency: 'MONTHLY', intervalMonths: 3 })).toMatchObject({ intervalWeeks: null, intervalMonths: null });
    expect(createRecurringExpenseSchema.parse({ ...creation, frequency: 'CUSTOM_MONTHS', intervalMonths: 3 })).toMatchObject({ intervalWeeks: null, intervalMonths: 3 });
    expect(() => createRecurringExpenseSchema.parse({ ...creation, frequency: 'CUSTOM_MONTHS' })).toThrow();
    expect(() => recurringIntervalsSchema.parse({ frequency: 'CUSTOM_WEEKS', intervalWeeks: null })).toThrow();
    expect(updateRecurringExpenseSchema.parse({ intervalWeeks: 4 }).intervalWeeks).toBe(4);
    expect(updateRecurringExpenseSchema.parse({ name: 'Nuevo nombre' })).not.toHaveProperty('intervalWeeks');
    expect(updateRecurringExpenseSchema.parse({ intervalWeeks: 4 })).not.toHaveProperty('remindersEnabled');
    expect(() => updateRecurringExpenseSchema.parse({})).toThrow();
  });
});

describe('API de recurrentes por semanas', () => {
  it('crea y devuelve intervalo en listado y detalle, sin día del mes ni meses residuales', async () => {
    const { app, database } = fixture();
    const result = await request(app).post(path).send({ ...creation, intervalMonths: 3, usualDayOfMonth: 31 }).expect(201);
    expect(result.body.data).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, intervalMonths: null, usualDayOfMonth: null });
    expect((await request(app).get(path).expect(200)).body.data[0].intervalWeeks).toBe(4);
    expect((await request(app).get(`${path}/${expenseId}`).expect(200)).body.data.intervalWeeks).toBe(4);
    expect(database.auditLog.create).toHaveBeenCalled();
  });

  it('clientes anteriores siguen creando MONTHLY sin intervalWeeks', async () => {
    const { app } = fixture();
    const { intervalWeeks: _, ...body } = creation;
    expect(_).toBe(4);
    const response = await request(app).post(path).send({ ...body, frequency: 'MONTHLY' }).expect(201);
    expect(response.body.data).toMatchObject({ frequency: 'MONTHLY', intervalWeeks: null, intervalMonths: null, usualDayOfMonth: 17 });
  });

  it('CUSTOM_WEEKS → MONTHLY limpia semanas en backend, aunque el cliente envíe el valor anterior', async () => {
    const { app, database } = fixture();
    const response = await request(app).patch(`${path}/${expenseId}`).send({ frequency: 'MONTHLY', intervalWeeks: 4 }).expect(200);
    expect(response.body.data).toMatchObject({ frequency: 'MONTHLY', intervalWeeks: null, intervalMonths: null, usualDayOfMonth: 17 });
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('CUSTOM_MONTHS → CUSTOM_WEEKS limpia meses aunque se omitan del PATCH', async () => {
    const { app } = fixture({ frequency: 'CUSTOM_MONTHS', intervalMonths: 3, intervalWeeks: null, usualDayOfMonth: 31 });
    const response = await request(app).patch(`${path}/${expenseId}`).send({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 4 }).expect(200);
    expect(response.body.data).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, intervalMonths: null, usualDayOfMonth: null });
  });

  it('al volver a meses usa el día del próximo vencimiento, no el viejo ancla mensual', async () => {
    const { app } = fixture({ usualDayOfMonth: 31, nextDueDate: new Date('2026-10-15') });
    const response = await request(app).patch(`${path}/${expenseId}`).send({ frequency: 'CUSTOM_MONTHS', intervalMonths: 3 }).expect(200);
    expect(response.body.data).toMatchObject({ intervalWeeks: null, intervalMonths: 3, usualDayOfMonth: 15 });
  });

  it('PATCH parcial conserva intervalo y permite cambiar solo las semanas', async () => {
    const { app } = fixture({ remindersEnabled: false });
    const renamed = await request(app).patch(`${path}/${expenseId}`).send({ name: 'Gimnasio nuevo' }).expect(200);
    expect(renamed.body.data).toMatchObject({ intervalWeeks: 4, intervalMonths: null });
    const changed = await request(app).patch(`${path}/${expenseId}`).send({ intervalWeeks: 3 }).expect(200);
    expect(changed.body.data).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 3, remindersEnabled: false });
  });

  it.each([undefined, null, 1, 2.5, 521])('POST y cambio a semanas rechazan intervalo inválido %s sin escribir', async (intervalWeeks) => {
    const { app, database } = fixture({ frequency: 'MONTHLY', intervalWeeks: null });
    await request(app).post(path).send({ ...creation, intervalWeeks }).expect(400);
    await request(app).patch(`${path}/${expenseId}`).send({ frequency: 'CUSTOM_WEEKS', intervalWeeks }).expect(400);
    expect(database.recurringExpense.create).not.toHaveBeenCalled();
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
  });

  it('no permite borrar un intervalo requerido ni cambiar a meses sin intervalo', async () => {
    const { app, database } = fixture();
    await request(app).patch(`${path}/${expenseId}`).send({ intervalWeeks: null }).expect(400);
    await request(app).patch(`${path}/${expenseId}`).send({ frequency: 'CUSTOM_MONTHS' }).expect(400);
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
  });

  it.each([
    ['PAID', 'KEEP_PREVIOUS', 4100, 4000],
    ['PAID', 'UPDATE_NEXT_AMOUNT', 4100, 4100],
    ['SKIPPED', 'KEEP_PREVIOUS', null, 4000],
  ])('pago %s / %s conserva importes e histórico y avanza 28 días', async (status, nextAmountDecision, actualAmountCents, nextAmount) => {
    const { app, state } = fixture();
    await request(app).post(`${path}/${expenseId}/payments`).send({ status, nextAmountDecision, actualAmountCents, ...(status === 'PAID' ? { paymentDate: '2026-09-17' } : {}) }).expect(201);
    expect(state.expense).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, amountCents: nextAmount, nextDueDate: new Date('2026-10-15') });
    expect(state.payments[0]).toMatchObject({ status, expectedAmountCents: 4000, actualAmountCents, nextAmountDecision, dueDate: new Date('2026-09-17') });
  });

  it('cuatro pagos consecutivos producen 15/10,12/11,10/12,07/01 sin perder históricos', async () => {
    const { app, state } = fixture();
    for (const expected of ['2026-10-15', '2026-11-12', '2026-12-10', '2027-01-07']) {
      await request(app).post(`${path}/${expenseId}/payments`).send({ status: 'PAID', actualAmountCents: 4000 }).expect(201);
      expect(state.expense.nextDueDate.toISOString().slice(0, 10)).toBe(expected);
    }
    expect(state.payments.map((payment) => payment.dueDate.toISOString().slice(0, 10))).toEqual(['2026-09-17', '2026-10-15', '2026-11-12', '2026-12-10']);
  });

  it('la API pública ya no permite crear un histórico arbitrario fuera de orden', async () => {
    const { app, state } = fixture();
    const response = await request(app).post(`${path}/${expenseId}/payments`).send({ status: 'PAID', actualAmountCents: 4000, dueDate: '2026-08-20' }).expect(409);
    expect(response.body.code).toBe('PAYMENT_NOT_CURRENT_OCCURRENCE');
    expect(state.expense.nextDueDate).toEqual(new Date('2026-09-17'));
    expect(state.payments).toHaveLength(0);
  });

  it('MONTHLY sigue meses naturales: 31/01 → 28/02 → 31/03', async () => {
    const { app, state } = fixture({ frequency: 'MONTHLY', intervalWeeks: null, usualDayOfMonth: 31, startDate: new Date('2026-01-31'), nextDueDate: new Date('2026-01-31') });
    for (const date of ['2026-02-28', '2026-03-31']) {
      await request(app).post(`${path}/${expenseId}/payments`).send({ status: 'PAID', actualAmountCents: 4000 }).expect(201);
      expect(state.expense.nextDueDate).toEqual(new Date(date));
    }
  });
});
