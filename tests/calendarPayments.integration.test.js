import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';
import { dateOrToday } from '../src/modules/finance/finance.service.js';
import { addCalendarDays, toIsoDate } from '../src/services/date.service.js';

// Explicit opt-in, local PostgreSQL only. Normal cases roll back every fixture.
// The concurrency case needs independent committed transactions: it creates only
// random-UUID synthetic rows and removes those exact rows in a finally block.
const enabled = process.env.CALENDAR_PAYMENTS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_CALENDAR_PAYMENTS_TEST');

function requireLocalDatabase() {
  const hostname = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Las pruebas del calendario solo admiten una base de datos local.');
  }
}

async function createFixture(tx, userIds) {
  for (const userId of userIds) {
    await tx.user.create({
      data: { id: userId, name: 'Calendar payment test', email: `${userId}@calendar-payment-test.invalid` },
    });
  }
  const household = await tx.household.create({
    data: { name: 'Calendar payment test', ownerUserId: userIds[0] },
  });
  const people = [];
  for (const [index, userId] of userIds.entries()) {
    await tx.householdUserAccess.create({
      data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' },
    });
    people.push(await tx.householdPerson.create({
      data: { householdId: household.id, linkedUserId: userId, name: `Calendar person ${index}`, contributionBps: 5000 },
    }));
  }
  const category = await tx.category.create({
    data: { householdId: household.id, name: 'Calendar test', slug: 'calendar-test', icon: 'Zap', color: '#000000' },
  });
  const expenseData = {
    householdId: household.id,
    categoryId: category.id,
    name: 'Gimnasio de prueba',
    amountCents: 4000,
    frequency: 'CUSTOM_WEEKS',
    intervalWeeks: 4,
    startDate: new Date('2026-09-17T00:00:00.000Z'),
    nextDueDate: new Date('2026-10-15T00:00:00.000Z'),
  };
  const expense = await tx.recurringExpense.create({ data: expenseData });
  return { household, userIds, people, category, expense, expenseData };
}

function appFor(prisma, userId) {
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({
    prisma,
    authenticate: (req, _res, next) => { req.auth = { userId }; next(); },
    requireCsrf: (_req, _res, next) => next(),
  }));
  app.use((error, _req, res, _next) => res
    .status(error.statusCode ?? (error.issues ? 400 : 500))
    .json({ code: error.code ?? 'VALIDATION_ERROR', details: error.issues }));
  return app;
}

function transactionAdapter(tx) {
  // Route operations use this outer transaction so successful HTTP requests can
  // still be rolled back. Only the separate concurrency case tests isolation.
  const adapter = new Proxy(tx, {
    get: (target, property) => property === '$transaction'
      ? (operation) => operation(adapter)
      : Reflect.get(target, property),
  });
  return adapter;
}

async function withRollbackFixture(operation) {
  requireLocalDatabase();
  const userIds = [crypto.randomUUID(), crypto.randomUUID()];
  try {
    await database.$transaction(async (tx) => {
      const fixture = await createFixture(tx, userIds);
      const app = appFor(transactionAdapter(tx), userIds[0]);
      await operation(tx, { ...fixture, app });
      throw rollback;
    }, { timeout: 20_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

async function withConcurrentFixture(operation) {
  requireLocalDatabase();
  const userIds = [crypto.randomUUID(), crypto.randomUUID()];
  let fixture;
  try {
    fixture = await database.$transaction((tx) => createFixture(tx, userIds));
    await operation(fixture);
  } finally {
    if (fixture) {
      await database.$transaction(async (tx) => {
        await tx.auditLog.deleteMany({ where: { householdId: fixture.household.id } });
        await tx.expensePayment.deleteMany({ where: { recurringExpenseId: fixture.expense.id } });
        await tx.recurringExpense.delete({ where: { id: fixture.expense.id } });
        await tx.category.delete({ where: { id: fixture.category.id } });
        await tx.householdPerson.deleteMany({ where: { id: { in: fixture.people.map((person) => person.id) } } });
        await tx.householdUserAccess.deleteMany({ where: { householdId: fixture.household.id, userId: { in: userIds } } });
        await tx.household.delete({ where: { id: fixture.household.id } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      });
    }
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

function paymentsPath(fixture, expenseId = fixture.expense.id) {
  return `/api/households/${fixture.household.id}/recurring-expenses/${expenseId}/payments`;
}

async function calendarEvents(fixture, options = {}) {
  const { body } = await request(options.app ?? fixture.app)
    .get(`/api/households/${fixture.household.id}/calendar`)
    .query({ view: '90_DAYS', anchorDate: '2026-10-15', ...options.query })
    .expect(200);
  return body.data.events;
}

const paid = (dueDate, overrides = {}) => ({
  status: 'PAID', dueDate, actualAmountCents: 4000, paymentDate: '2026-10-15', ...overrides,
});

// Both real serializable transactions must read the same current occurrence
// before either can write. Retries proceed normally after the first two reads.
function synchronizeExpenseReads(prisma, expenseId) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return new Proxy(prisma, {
    get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property);
      return (operation, options) => target.$transaction((tx) => {
        const delegate = new Proxy(tx.recurringExpense, {
          get(model, method) {
            if (method !== 'findFirst') return Reflect.get(model, method);
            return async (args) => {
              const expense = await model.findFirst(args);
              if (expense?.id === expenseId && arrivals < 2) {
                arrivals += 1;
                if (arrivals === 2) release();
                await gate;
              }
              return expense;
            };
          },
        });
        return operation(new Proxy(tx, {
          get: (transaction, key) => key === 'recurringExpense' ? delegate : Reflect.get(transaction, key),
        }));
      }, options);
    },
  });
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('calendario interactivo y pagos con PostgreSQL real', () => {
  it('incluye facturas, variables y puntuales con fechas correctas y privacidad por hogar y persona', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      const ownIds = [];
      const hiddenIds = [];
      for (const person of [null, ...fixture.people]) {
        const base = {
          householdId: fixture.household.id, categoryId: fixture.category.id,
          scope: person ? 'PERSONAL' : 'HOUSEHOLD', personalPersonId: person?.id ?? null,
        };
        const invoice = await tx.utilityInvoice.create({ data: {
          ...base, amountCents: 1500, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'),
          invoiceDate: new Date('2026-09-30'), chargeDate: new Date('2026-10-10'),
        } });
        const oneTime = await tx.oneTimeExpense.create({ data: {
          ...base, name: 'Reparación de prueba', amountCents: 2500, expenseDate: new Date('2026-10-12'),
        } });
        const variable = await tx.variableExpenseMonth.create({ data: {
          ...base, ownerKey: person?.id ?? 'HOUSEHOLD', year: 2026, month: 10,
          entryMode: 'DETAIL', isComplete: false,
          entries: { create: { spentOn: new Date('2026-10-14'), merchant: 'Tienda de prueba', amountCents: 3500 } },
        }, include: { entries: true } });
        const target = person?.id === fixture.people[1].id ? hiddenIds : ownIds;
        target.push(invoice.id, oneTime.id, variable.entries[0].id);
      }
      const outsideInvoice = await tx.utilityInvoice.create({ data: {
        householdId: fixture.household.id, categoryId: fixture.category.id, amountCents: 9999,
        periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'),
        invoiceDate: new Date('2026-10-10'), chargeDate: new Date('2026-11-01'),
      } });
      hiddenIds.push(outsideInvoice.id);
      const otherHousehold = await tx.household.create({ data: { name: 'Otro hogar de prueba', ownerUserId: fixture.userIds[1] } });
      const otherCategory = await tx.category.create({ data: { householdId: otherHousehold.id, name: 'Otra categoría', slug: 'other-test', icon: 'Zap', color: '#000000' } });
      const otherExpense = await tx.oneTimeExpense.create({ data: { householdId: otherHousehold.id, categoryId: otherCategory.id, name: 'Otro hogar', expenseDate: new Date('2026-10-12'), amountCents: 9999 } });
      hiddenIds.push(otherExpense.id);

      const events = await calendarEvents(fixture, { query: { view: 'MONTH', anchorDate: '2026-10-15' } });
      expect(events.filter((event) => event.id).map((event) => event.id).sort()).toEqual(ownIds.sort());
      expect(events.some((event) => hiddenIds.includes(event.id))).toBe(false);
      expect(events.filter((event) => event.sourceType === 'INVOICE')).toEqual([
        expect.objectContaining({ dueDate: '2026-10-10', dateBasis: 'CHARGE_DATE', status: 'RECORDED' }),
        expect.objectContaining({ dueDate: '2026-10-10', dateBasis: 'CHARGE_DATE', status: 'RECORDED' }),
      ]);
      const rolling = await calendarEvents(fixture, { query: { view: '30_DAYS', anchorDate: '2026-10-15' } });
      expect(rolling.some((event) => ownIds.includes(event.id))).toBe(false);
      expect(rolling.find((event) => event.id === outsideInvoice.id)).toMatchObject({ dueDate: '2026-11-01' });

      // Summary ranges must include overlapping months on both sides of a year boundary.
      for (const [year, month] of [[2026, 12], [2027, 1]]) {
        await tx.variableExpenseMonth.create({ data: {
          householdId: fixture.household.id, categoryId: fixture.category.id, ownerKey: 'HOUSEHOLD',
          year, month, entryMode: 'SUMMARY', summaryAmountCents: 1200,
        } });
      }
      const yearBoundary = await calendarEvents(fixture, { query: { view: '30_DAYS', anchorDate: '2026-12-20' } });
      expect(yearBoundary.filter((event) => event.sourceType === 'VARIABLE_SUMMARY').map((event) => event.periodStart))
        .toEqual(['2026-12-01', '2027-01-01']);
    });
  });

  it('15/10 pagado → 12/11 omitido → 10/12 accionable, con histórico visible en el calendario', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      const before = (await calendarEvents(fixture)).slice(0, 3);
      expect(before.map(({ dueDate, canRegisterPayment, canEditPayment }) => ({ dueDate, canRegisterPayment, canEditPayment }))).toEqual([
        { dueDate: '2026-10-15', canRegisterPayment: true, canEditPayment: false },
        { dueDate: '2026-11-12', canRegisterPayment: false, canEditPayment: false },
        { dueDate: '2026-12-10', canRegisterPayment: false, canEditPayment: false },
      ]);

      const first = await request(fixture.app).post(paymentsPath(fixture))
        .send(paid('2026-10-15', { notes: 'Cuota de octubre' })).expect(201);
      expect(first.body.data.recurringExpense.nextDueDate).toBe('2026-11-12T00:00:00.000Z');
      let events = await calendarEvents(fixture);
      expect(events[0]).toMatchObject({
        dueDate: '2026-10-15', paymentId: first.body.data.payment.id, status: 'PAID',
        canRegisterPayment: false, canEditPayment: true, expectedAmountCents: 4000,
        actualAmountCents: 4000, paymentDate: '2026-10-15', notes: 'Cuota de octubre',
      });
      expect(events[1]).toMatchObject({ dueDate: '2026-11-12', canRegisterPayment: true });
      expect(events[2]).toMatchObject({ dueDate: '2026-12-10', canRegisterPayment: false });

      const second = await request(fixture.app).post(paymentsPath(fixture))
        .send({ status: 'SKIPPED', dueDate: '2026-11-12', notes: 'Mes de vacaciones' }).expect(201);
      expect(second.body.data.recurringExpense.nextDueDate).toBe('2026-12-10T00:00:00.000Z');
      events = await calendarEvents(fixture);
      expect(events[1]).toMatchObject({
        dueDate: '2026-11-12', paymentId: second.body.data.payment.id, status: 'SKIPPED',
        canRegisterPayment: false, canEditPayment: true, actualAmountCents: null,
        paymentDate: null, notes: 'Mes de vacaciones',
      });
      expect(events[2]).toMatchObject({ dueDate: '2026-12-10', canRegisterPayment: true, canEditPayment: false });
      expect(await tx.expensePayment.count({ where: { recurringExpenseId: fixture.expense.id } })).toBe(2);
    });
  });

  it('rechaza fechas posteriores, anteriores o arbitrarias sin escribir y devuelve conflicto para el duplicado', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      for (const dueDate of ['2026-11-12', '2026-09-17', '2026-10-16']) {
        const rejected = await request(fixture.app).post(paymentsPath(fixture)).send(paid(dueDate)).expect(409);
        expect(rejected.body.code).toBe('PAYMENT_NOT_CURRENT_OCCURRENCE');
      }
      expect(await tx.expensePayment.count({ where: { recurringExpenseId: fixture.expense.id } })).toBe(0);
      expect(await tx.auditLog.count({ where: { householdId: fixture.household.id } })).toBe(0);
      expect(await tx.recurringExpense.findUnique({ where: { id: fixture.expense.id } })).toEqual(fixture.expense);
      await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-10-15')).expect(201);
      const duplicate = await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-10-15')).expect(409);
      expect(duplicate.body.code).toBe('PAYMENT_ALREADY_REGISTERED');
      expect(await tx.expensePayment.count({ where: { recurringExpenseId: fixture.expense.id } })).toBe(1);
    });
  });

  it('UPDATE_NEXT_AMOUNT cambia el futuro una vez; corregir PAID ↔ SKIPPED no lo altera', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      const created = await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-10-15', {
        actualAmountCents: 4200, nextAmountDecision: 'UPDATE_NEXT_AMOUNT', nextExpectedAmountCents: 4200,
      })).expect(201);
      const future = await tx.recurringExpense.findUnique({ where: { id: fixture.expense.id } });
      expect(future).toMatchObject({ amountCents: 4200, nextDueDate: new Date('2026-11-12T00:00:00.000Z') });
      const historicalPath = `${paymentsPath(fixture)}/${created.body.data.payment.id}`;
      const skipped = await request(fixture.app).patch(historicalPath)
        .send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null, notes: 'Corrección' }).expect(200);
      expect(skipped.body.data).toMatchObject({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null });
      expect(await tx.auditLog.findFirst({
        where: { householdId: fixture.household.id, action: 'EXPENSE_CHANGED', resourceId: created.body.data.payment.id },
      })).toMatchObject({
        metadata: { previousNextAmountDecision: 'UPDATE_NEXT_AMOUNT', previousNextExpectedAmountCents: 4200 },
      });
      await request(fixture.app).patch(historicalPath)
        .send({ status: 'PAID', actualAmountCents: null, paymentDate: null }).expect(400);
      const corrected = await request(fixture.app).patch(historicalPath)
        .send({ status: 'PAID', actualAmountCents: 4500, paymentDate: '2026-10-20', notes: 'Importe corregido' }).expect(200);
      expect(corrected.body.data).toMatchObject({
        dueDate: '2026-10-15T00:00:00.000Z', expectedAmountCents: 4000, actualAmountCents: 4500,
        paymentDate: '2026-10-20T00:00:00.000Z', nextAmountDecision: 'KEEP_PREVIOUS', nextExpectedAmountCents: null,
      });
      expect(await tx.recurringExpense.findUnique({ where: { id: fixture.expense.id } })).toEqual(future);
      const events = await calendarEvents(fixture);
      expect(events[0]).toMatchObject({ status: 'PAID', amountCents: 4500, paymentDate: '2026-10-20', canEditPayment: true });
      expect(events[1]).toMatchObject({ amountCents: 4200, canRegisterPayment: true });
    });
  });

  it('corrige directamente el importe de un PAID con UPDATE_NEXT_AMOUNT sin infringir la constraint ni cambiar el futuro', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      const created = await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-10-15', {
        actualAmountCents: 4200, nextAmountDecision: 'UPDATE_NEXT_AMOUNT', nextExpectedAmountCents: 4200,
      })).expect(201);
      const future = await tx.recurringExpense.findUnique({ where: { id: fixture.expense.id } });
      const historicalPath = `${paymentsPath(fixture)}/${created.body.data.payment.id}`;
      // Changing only descriptive data must not erase a still-consistent record
      // of the original amount decision, nor apply that decision a second time.
      const notesOnly = await request(fixture.app).patch(historicalPath)
        .send({ status: 'PAID', actualAmountCents: 4200, paymentDate: '2026-10-20', notes: 'Fecha corregida' }).expect(200);
      expect(notesOnly.body.data).toMatchObject({ nextAmountDecision: 'UPDATE_NEXT_AMOUNT', nextExpectedAmountCents: 4200 });
      const response = await request(fixture.app).patch(`${paymentsPath(fixture)}/${created.body.data.payment.id}`)
        .send({ status: 'PAID', actualAmountCents: 4500, paymentDate: '2026-10-20', notes: 'Corrección de importe' }).expect(200);
      expect(response.body.data).toMatchObject({
        actualAmountCents: 4500, nextAmountDecision: 'KEEP_PREVIOUS', nextExpectedAmountCents: null,
      });
      expect(await tx.recurringExpense.findUnique({ where: { id: fixture.expense.id } })).toEqual(future);
      expect(future).toMatchObject({ amountCents: 4200, nextDueDate: new Date('2026-11-12T00:00:00.000Z') });
      const corrections = await tx.auditLog.findMany({
        where: { householdId: fixture.household.id, action: 'EXPENSE_CHANGED', resourceId: created.body.data.payment.id },
      });
      expect(corrections.some((entry) => entry.metadata?.previousNextAmountDecision === 'UPDATE_NEXT_AMOUNT'
        && entry.metadata?.previousNextExpectedAmountCents === 4200)).toBe(true);
    });
  });

  it.each([false, true])('un gasto inactivo (archivado=%s) no admite nuevos pagos pero conserva la corrección del histórico', async (archived) => {
    await withRollbackFixture(async (tx, fixture) => {
      const created = await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-10-15')).expect(201);
      await tx.recurringExpense.update({
        where: { id: fixture.expense.id }, data: { isActive: false, archivedAt: archived ? new Date() : null },
      });
      const events = await calendarEvents(fixture);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ paymentId: created.body.data.payment.id, status: 'PAID', canRegisterPayment: false, canEditPayment: true });
      await request(fixture.app).post(paymentsPath(fixture)).send(paid('2026-11-12')).expect(404);
      await request(fixture.app).patch(`${paymentsPath(fixture)}/${created.body.data.payment.id}`)
        .send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(200);
      expect(await tx.expensePayment.count({ where: { recurringExpenseId: fixture.expense.id } })).toBe(1);
    });
  });

  it('no expone ni permite registrar o corregir gastos personales ajenos, incluso al propietario del hogar', async () => {
    await withRollbackFixture(async (tx, fixture) => {
      const personal = [];
      for (const [index, person] of fixture.people.entries()) {
        personal.push(await tx.recurringExpense.create({
          data: { ...fixture.expenseData, name: `Personal ${index}`, scope: 'PERSONAL', personalPersonId: person.id },
        }));
      }
      const otherApp = appFor(transactionAdapter(tx), fixture.userIds[1]);
      const recorded = await request(otherApp).post(paymentsPath(fixture, personal[1].id))
        .send(paid('2026-10-15')).expect(201);
      const ownerEvents = await calendarEvents(fixture);
      expect(new Set(ownerEvents.map((event) => event.expenseId))).toEqual(new Set([fixture.expense.id, personal[0].id]));
      const memberEvents = await calendarEvents(fixture, { app: otherApp });
      expect(new Set(memberEvents.map((event) => event.expenseId))).toEqual(new Set([fixture.expense.id, personal[1].id]));
      expect(memberEvents.find((event) => event.paymentId === recorded.body.data.payment.id)).toMatchObject({ canEditPayment: true });
      const hiddenPath = paymentsPath(fixture, personal[1].id);
      await request(fixture.app).post(hiddenPath).send(paid('2026-11-12')).expect(404);
      await request(fixture.app).patch(`${hiddenPath}/${recorded.body.data.payment.id}`)
        .send({ status: 'SKIPPED', actualAmountCents: null, paymentDate: null }).expect(404);
      expect(await tx.expensePayment.count({ where: { recurringExpenseId: personal[1].id } })).toBe(1);
      expect(await tx.expensePayment.findUnique({ where: { id: recorded.body.data.payment.id } })).toMatchObject({ status: 'PAID' });
    });
  });

  it.each([[-7, 'OVERDUE'], [8, 'UPCOMING']])('el vencimiento actual a %s días (%s) se puede pagar hoy conservando ambas fechas', async (offset, status) => {
    await withRollbackFixture(async (tx, fixture) => {
      const today = dateOrToday();
      const dueDate = addCalendarDays(today, offset);
      await tx.recurringExpense.update({ where: { id: fixture.expense.id }, data: { startDate: dueDate, nextDueDate: dueDate } });
      const events = await calendarEvents(fixture, { query: { anchorDate: toIsoDate(addCalendarDays(today, -7)) } });
      expect(events[0]).toMatchObject({ dueDate: toIsoDate(dueDate), status, canRegisterPayment: true });
      const result = await request(fixture.app).post(paymentsPath(fixture))
        .send(paid(toIsoDate(dueDate), { paymentDate: toIsoDate(today) })).expect(201);
      expect(result.body.data.payment).toMatchObject({ dueDate: dueDate.toISOString(), paymentDate: today.toISOString() });
      expect(result.body.data.recurringExpense.nextDueDate).toBe(addCalendarDays(dueDate, 28).toISOString());
    });
  });

  it('dos dispositivos concurrentes registran una sola vez y PostgreSQL mantiene la constraint única', async () => {
    await withConcurrentFixture(async (fixture) => {
      const app = appFor(synchronizeExpenseReads(database, fixture.expense.id), fixture.userIds[0]);
      const responses = await Promise.all([
        request(app).post(paymentsPath(fixture)).send(paid('2026-10-15')),
        request(app).post(paymentsPath(fixture)).send(paid('2026-10-15')),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(responses.find((response) => response.status === 409).body.code).toBe('PAYMENT_ALREADY_REGISTERED');
      expect(await database.expensePayment.count({ where: { recurringExpenseId: fixture.expense.id } })).toBe(1);
      expect(await database.auditLog.count({ where: { householdId: fixture.household.id, action: 'PAYMENT_REGISTERED' } })).toBe(1);
      expect(await database.recurringExpense.findUnique({ where: { id: fixture.expense.id } })).toMatchObject({
        amountCents: 4000, nextDueDate: new Date('2026-11-12T00:00:00.000Z'),
      });
      // Bypassing the HTTP guard still cannot create the same occurrence twice.
      await expect(database.expensePayment.create({
        data: {
          recurringExpenseId: fixture.expense.id, recordedByUserId: fixture.userIds[0],
          dueDate: new Date('2026-10-15T00:00:00.000Z'), expectedAmountCents: 4000,
          status: 'SKIPPED',
        },
      })).rejects.toMatchObject({ code: 'P2002' });
    });
  }, 20_000);
});
