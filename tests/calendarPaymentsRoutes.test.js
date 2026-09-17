import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';

const householdId = '41000000-0000-4000-8000-000000000001';
const userId = '41000000-0000-4000-8000-000000000002';
const expenseId = '41000000-0000-4000-8000-000000000003';
const ownPersonId = '41000000-0000-4000-8000-000000000004';
const ownExpenseId = '41000000-0000-4000-8000-000000000005';
const otherPersonId = '41000000-0000-4000-8000-000000000006';
const otherExpenseId = '41000000-0000-4000-8000-000000000007';
const otherUserId = '41000000-0000-4000-8000-000000000008';
const paymentPath = (id = expenseId) => `/api/households/${householdId}/recurring-expenses/${id}/payments`;
const calendarPath = `/api/households/${householdId}/calendar`;
const paid = { dueDate: '2026-10-15', status: 'PAID', actualAmountCents: 4200, paymentDate: '2026-10-14', notes: 'Pagado anticipadamente' };
const iso = (date) => new Date(date).toISOString().slice(0, 10);

function matches(expense, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((condition) => matches(expense, condition));
    if (key === 'personalPerson') return expense.personalPerson?.linkedUserId === value.linkedUserId;
    return expense[key] === value;
  });
}

function fixture(overrides = {}) {
  const base = {
    id: expenseId, householdId, name: 'Gimnasio', scope: 'HOUSEHOLD',
    amountCents: 4000, frequency: 'CUSTOM_WEEKS', intervalWeeks: 4,
    intervalMonths: null, usualDayOfMonth: null,
    startDate: new Date('2026-09-17'), nextDueDate: new Date('2026-10-15'),
    isActive: true, archivedAt: null, personalPersonId: null, personalPerson: null,
    category: { id: crypto.randomUUID(), name: 'Ocio' }, ...overrides,
  };
  const state = {
    expenses: [base, {
      ...base, id: ownExpenseId, scope: 'PERSONAL', personalPersonId: ownPersonId,
      personalPerson: { id: ownPersonId, name: 'Yo', linkedUserId: userId },
    }, {
      ...base, id: otherExpenseId, name: 'Privado ajeno', scope: 'PERSONAL', personalPersonId: otherPersonId,
      personalPerson: { id: otherPersonId, name: 'Otra persona', linkedUserId: otherUserId },
    }],
    payments: [],
  };
  const database = {
    householdUserAccess: { findFirst: vi.fn().mockResolvedValue({ role: 'MEMBER', household: { id: householdId, isActive: true } }) },
    householdPerson: { findMany: vi.fn(async () => state.expenses.flatMap((expense) => expense.personalPerson ?? [])) },
    recurringExpense: {
      findMany: vi.fn(async () => state.expenses),
      findFirst: vi.fn(async ({ where }) => state.expenses.find((expense) => matches(expense, where)) ?? null),
      update: vi.fn(async ({ where, data }) => {
        const expense = state.expenses.find((item) => item.id === where.id);
        Object.assign(expense, data);
        return { ...expense };
      }),
    },
    expensePayment: {
      findUnique: vi.fn(async ({ where }) => state.payments.find((payment) =>
        payment.recurringExpenseId === where.recurringExpenseId_dueDate.recurringExpenseId &&
        iso(payment.dueDate) === iso(where.recurringExpenseId_dueDate.dueDate),
      ) ?? null),
      findFirst: vi.fn(async ({ where }) => {
        const payment = state.payments.find((item) => item.id === where.id && item.recurringExpenseId === where.recurringExpenseId);
        return payment ? { ...payment } : null;
      }),
      findMany: vi.fn(async () => state.payments),
      create: vi.fn(async ({ data }) => {
        if (state.payments.some((payment) => payment.recurringExpenseId === data.recurringExpenseId && iso(payment.dueDate) === iso(data.dueDate))) {
          throw Object.assign(new Error('Unique occurrence'), { code: 'P2002' });
        }
        const payment = { id: crypto.randomUUID(), ...data };
        state.payments.push(payment);
        return payment;
      }),
      update: vi.fn(async ({ where, data }) => {
        const payment = state.payments.find((item) => item.id === where.id);
        Object.assign(payment, data);
        return { ...payment };
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
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 400).json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message, details: error.issues }));
  return { app, database, state, expense: base };
}

describe('calendar payment operations', () => {
  it('15/10 pagado → 12/11 accionable → omitido → 10/12 accionable, sin saltos', async () => {
    const { app, state, database } = fixture();
    const read = async () => (await request(app).get(calendarPath).query({ view: '90_DAYS', anchorDate: '2026-10-01' }).expect(200)).body.data.events.filter((event) => event.expenseId === expenseId);
    expect((await read()).map(({ dueDate, canRegisterPayment }) => [dueDate, canRegisterPayment])).toEqual([
      ['2026-10-15', true], ['2026-11-12', false], ['2026-12-10', false],
    ]);
    await request(app).post(paymentPath()).send(paid).expect(201);
    const afterPaid = await read();
    expect(afterPaid[0]).toMatchObject({ status: 'PAID', amountCents: 4200, expectedAmountCents: 4000, actualAmountCents: 4200, paymentDate: '2026-10-14', notes: paid.notes, paymentId: state.payments[0].id, canRegisterPayment: false, canEditPayment: true });
    expect(afterPaid.slice(1).map(({ dueDate, canRegisterPayment }) => [dueDate, canRegisterPayment])).toEqual([['2026-11-12', true], ['2026-12-10', false]]);
    await request(app).post(paymentPath()).send({ status: 'SKIPPED', dueDate: '2026-11-12', notes: 'Vacaciones' }).expect(201);
    const afterSkipped = await read();
    expect(afterSkipped[1]).toMatchObject({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null, notes: 'Vacaciones', canEditPayment: true, canRegisterPayment: false });
    expect(afterSkipped[2]).toMatchObject({ dueDate: '2026-12-10', canRegisterPayment: true });
    expect(state.payments[1]).toMatchObject({ nextAmountDecision: 'KEEP_PREVIOUS', nextExpectedAmountCents: null });
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it.each(['2026-11-12', '2026-12-10', '2026-09-17', '2026-10-16'])(
    'rechaza fecha fuera de orden %s sin pago, avance ni auditoría', async (dueDate) => {
      const { app, database, expense } = fixture();
      const response = await request(app).post(paymentPath()).send({ ...paid, dueDate }).expect(409);
      expect(response.body).toMatchObject({ code: 'PAYMENT_NOT_CURRENT_OCCURRENCE', message: 'Primero registra el vencimiento pendiente anterior.' });
      expect(database.expensePayment.create).not.toHaveBeenCalled();
      expect(database.recurringExpense.update).not.toHaveBeenCalled();
      expect(database.auditLog.create).not.toHaveBeenCalled();
      expect(iso(expense.nextDueDate)).toBe('2026-10-15');
    },
  );

  it.each(['PAID', 'SKIPPED'])('rechaza ocurrencia posterior también para %s', async (status) => {
    const { app } = fixture();
    const response = await request(app).post(paymentPath()).send({ dueDate: '2026-11-12', status, actualAmountCents: status === 'PAID' ? 4000 : null }).expect(409);
    expect(response.body.code).toBe('PAYMENT_NOT_CURRENT_OCCURRENCE');
  });

  it.each([
    ['2026-09-10', '2026-09-17'], ['2026-09-25', '2026-09-17'],
  ])('conserva vencimiento %s y pago real %s, atrasado o anticipado', async (dueDate, paymentDate) => {
    const { app, state } = fixture({ nextDueDate: new Date(dueDate) });
    await request(app).post(paymentPath()).send({ ...paid, dueDate, paymentDate }).expect(201);
    expect(iso(state.payments[0].dueDate)).toBe(dueDate);
    expect(iso(state.payments[0].paymentDate)).toBe(paymentDate);
  });

  it('UPDATE_NEXT_AMOUNT usa el real, mantiene el esperado histórico y lo refleja en calendario', async () => {
    const { app, state, expense } = fixture();
    await request(app).post(paymentPath()).send({ ...paid, nextAmountDecision: 'UPDATE_NEXT_AMOUNT', nextExpectedAmountCents: 4200 }).expect(201);
    expect(expense.amountCents).toBe(4200);
    expect(state.payments[0]).toMatchObject({ expectedAmountCents: 4000, actualAmountCents: 4200, nextExpectedAmountCents: 4200 });
    const response = await request(app).get(calendarPath).query({ view: '90_DAYS', anchorDate: '2026-10-01' }).expect(200);
    expect(response.body.data.events.find((event) => event.expenseId === expenseId && event.dueDate === '2026-11-12')).toMatchObject({ amountCents: 4200, expectedAmountCents: 4200, canRegisterPayment: true });
  });

  it('una pestaña obsoleta recibe duplicado prioritario sin volver a avanzar', async () => {
    const { app, state, expense, database } = fixture();
    await request(app).post(paymentPath()).send(paid).expect(201);
    const response = await request(app).post(paymentPath()).send(paid).expect(409);
    expect(response.body.code).toBe('PAYMENT_ALREADY_REGISTERED');
    expect(state.payments).toHaveLength(1);
    expect(iso(expense.nextDueDate)).toBe('2026-11-12');
    expect(database.recurringExpense.update).toHaveBeenCalledTimes(1);
  });

  it('el constraint sigue traduciéndose a duplicado si otro escritor gana tras la lectura', async () => {
    const { app, database } = fixture();
    database.expensePayment.create.mockRejectedValueOnce(Object.assign(new Error('Unique occurrence'), { code: 'P2002' }));
    const response = await request(app).post(paymentPath()).send(paid).expect(409);
    expect(response.body.code).toBe('PAYMENT_ALREADY_REGISTERED');
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
  });

  it('reintenta conflictos de serialización con todas las comprobaciones vigentes', async () => {
    const { app, database } = fixture();
    database.$transaction.mockRejectedValueOnce(Object.assign(new Error('Serialization'), { code: 'P2034' }));
    await request(app).post(paymentPath()).send(paid).expect(201);
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(database.expensePayment.create).toHaveBeenCalledTimes(1);
  });

  it.each([{ isActive: false }, { archivedAt: new Date('2026-10-01') }])('rechaza nuevas operaciones de recurrentes no activos %j', async (overrides) => {
    const { app, database } = fixture(overrides);
    expect((await request(app).post(paymentPath()).send(paid).expect(404)).body.code).toBe('RECURRING_EXPENSE_NOT_FOUND');
    expect(database.expensePayment.create).not.toHaveBeenCalled();
  });

  it('mantiene el duplicado reconocible después de archivar el gasto', async () => {
    const { app, expense } = fixture();
    await request(app).post(paymentPath()).send(paid).expect(201);
    expense.archivedAt = new Date('2026-10-16');
    expense.isActive = false;
    expect((await request(app).post(paymentPath()).send(paid).expect(409)).body.code).toBe('PAYMENT_ALREADY_REGISTERED');
  });

  it('PAID → SKIPPED limpia datos reales y no reconstruye futuro aunque antes se actualizara importe', async () => {
    const { app, state, expense, database } = fixture();
    await request(app).post(paymentPath()).send({ ...paid, nextAmountDecision: 'UPDATE_NEXT_AMOUNT' }).expect(201);
    database.recurringExpense.update.mockClear();
    const snapshot = { ...expense };
    const payment = state.payments[0];
    await request(app).patch(`${paymentPath()}/${payment.id}`).send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null, notes: 'Corrección histórica' }).expect(200);
    expect(payment).toMatchObject({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null, notes: 'Corrección histórica', expectedAmountCents: 4000, nextAmountDecision: 'KEEP_PREVIOUS', nextExpectedAmountCents: null });
    expect(expense).toEqual(snapshot);
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
    expect(database.auditLog.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ metadata: expect.objectContaining({ previousNextAmountDecision: 'UPDATE_NEXT_AMOUNT', previousNextExpectedAmountCents: 4200, amountDecisionClearedByHistoricalCorrection: true }) }) });
  });

  it('corregir el importe PAID normaliza la decisión histórica sin aplicar el importe corregido al futuro', async () => {
    const { app, state, expense, database } = fixture();
    await request(app).post(paymentPath()).send({ ...paid, nextAmountDecision: 'UPDATE_NEXT_AMOUNT' }).expect(201);
    database.recurringExpense.update.mockClear();
    await request(app).patch(`${paymentPath()}/${state.payments[0].id}`).send({ status: 'PAID', actualAmountCents: 4500, paymentDate: '2026-10-18' }).expect(200);
    expect(state.payments[0]).toMatchObject({ actualAmountCents: 4500, nextAmountDecision: 'KEEP_PREVIOUS', nextExpectedAmountCents: null });
    expect(expense.amountCents).toBe(4200);
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
  });

  it('corregir solo notas conserva una decisión histórica todavía compatible', async () => {
    const { app, state } = fixture();
    await request(app).post(paymentPath()).send({ ...paid, nextAmountDecision: 'UPDATE_NEXT_AMOUNT' }).expect(201);
    await request(app).patch(`${paymentPath()}/${state.payments[0].id}`).send({ status: 'PAID', actualAmountCents: 4200, paymentDate: '2026-10-14', notes: 'Otra nota' }).expect(200);
    expect(state.payments[0]).toMatchObject({ notes: 'Otra nota', nextAmountDecision: 'UPDATE_NEXT_AMOUNT', nextExpectedAmountCents: 4200 });
  });

  it.each([
    { actualAmountCents: null, paymentDate: '2026-10-18' },
    { actualAmountCents: 4000, paymentDate: null },
    { actualAmountCents: 4000 },
  ])('SKIPPED → PAID exige importe y fecha explícitos %j', async (fields) => {
    const { app, state, database } = fixture();
    await request(app).post(paymentPath()).send({ status: 'SKIPPED', dueDate: paid.dueDate }).expect(201);
    await request(app).patch(`${paymentPath()}/${state.payments[0].id}`).send({ status: 'PAID', ...fields }).expect(400);
    expect(database.expensePayment.update).not.toHaveBeenCalled();
    expect(state.payments[0].status).toBe('SKIPPED');
  });

  it('corrige SKIPPED → PAID incluso archivado y preserva las notas omitidas del PATCH', async () => {
    const { app, state, expense, database } = fixture();
    await request(app).post(paymentPath()).send({ status: 'SKIPPED', dueDate: paid.dueDate, notes: 'Nota existente' }).expect(201);
    expense.archivedAt = new Date('2026-10-16');
    expense.isActive = false;
    database.recurringExpense.update.mockClear();
    const response = await request(app).patch(`${paymentPath()}/${state.payments[0].id}`).send({ status: 'PAID', actualAmountCents: 4100, paymentDate: '2026-10-18' }).expect(200);
    expect(response.body.data).toMatchObject({ status: 'PAID', actualAmountCents: 4100, paymentDate: '2026-10-18T00:00:00.000Z', notes: 'Nota existente' });
    expect(database.recurringExpense.update).not.toHaveBeenCalled();
  });

  it.each(['dueDate', 'expectedAmountCents', 'nextAmountDecision', 'nextExpectedAmountCents'])(
    'PATCH no acepta mutar el futuro ni datos de ocurrencia mediante %s', async (key) => {
      const { app, state, database } = fixture();
      await request(app).post(paymentPath()).send(paid).expect(201);
      await request(app).patch(`${paymentPath()}/${state.payments[0].id}`).send({ status: 'PAID', actualAmountCents: 4100, paymentDate: '2026-10-18', [key]: 'forbidden' }).expect(400);
      expect(database.expensePayment.update).not.toHaveBeenCalled();
    },
  );

  it('solo expone comunes y personales propios con los permisos de acción correctos', async () => {
    const { app, state } = fixture();
    state.payments.push({ id: crypto.randomUUID(), recurringExpenseId: otherExpenseId, dueDate: new Date('2026-10-15'), status: 'PAID', actualAmountCents: 99999, notes: 'Privado' });
    const response = await request(app).get(calendarPath).query({ view: 'MONTH', anchorDate: '2026-10-01' }).expect(200);
    expect(response.body.data.events.map((event) => event.expenseId)).toEqual([expenseId, ownExpenseId]);
    expect(JSON.stringify(response.body)).not.toContain('Privado');
    expect(response.body.data.events.find((event) => event.expenseId === ownExpenseId)).toMatchObject({ canRegisterPayment: true, canEditPayment: false });
  });

  it('permite registrar y corregir personal propio pero no el ajeno ni usando su paymentId', async () => {
    const { app, state, database } = fixture();
    await request(app).post(paymentPath(ownExpenseId)).send(paid).expect(201);
    const ownPaymentId = state.payments[0].id;
    await request(app).patch(`${paymentPath(ownExpenseId)}/${ownPaymentId}`).send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(200);
    const otherPaymentId = crypto.randomUUID();
    state.payments.push({ id: otherPaymentId, recurringExpenseId: otherExpenseId, dueDate: new Date('2026-10-15'), status: 'PAID' });
    await request(app).post(paymentPath(otherExpenseId)).send(paid).expect(404);
    await request(app).patch(`${paymentPath(otherExpenseId)}/${otherPaymentId}`).send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(404);
    expect((await request(app).patch(`${paymentPath(ownExpenseId)}/${otherPaymentId}`).send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(404)).body.code).toBe('PAYMENT_NOT_FOUND');
    expect(database.expensePayment.create).toHaveBeenCalledTimes(1);
    expect(database.expensePayment.update).toHaveBeenCalledTimes(1);
  });

  it('comprueba acceso al hogar dentro de la transacción antes de leer datos o escribir', async () => {
    const { app, database } = fixture();
    database.householdUserAccess.findFirst.mockResolvedValue(null);
    await request(app).post(paymentPath()).send(paid).expect(404);
    await request(app).patch(`${paymentPath()}/${crypto.randomUUID()}`).send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(404);
    expect(database.recurringExpense.findFirst).not.toHaveBeenCalled();
    expect(database.expensePayment.create).not.toHaveBeenCalled();
    expect(database.expensePayment.update).not.toHaveBeenCalled();
  });
});
