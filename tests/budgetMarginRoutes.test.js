import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createFinanceRouter } from '../src/modules/finance/index.js';
import { loadFinancialInputs } from '../src/modules/finance/finance.service.js';

const id = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const householdId = id(1), categoryId = id(2), userA = id(3), userB = id(4), personA = id(5), personB = id(6);
const route = `/api/households/${householdId}/budget-margin-preferences`;
const common = { expenseType: 'INVOICE', categoryId, scope: 'HOUSEHOLD', personalPersonId: null, applySafetyMargin: true };

function fixture() {
  const people = [
    { id: personA, linkedUserId: userA, householdId, isActive: true, contributionBps: 5_000 },
    { id: personB, linkedUserId: userB, householdId, isActive: true, contributionBps: 5_000 },
  ];
  const category = { id: categoryId, householdId, name: 'Luz', safetyMarginBps: 1_500 };
  const household = { id: householdId, isActive: true, safetyMarginBps: 1_000, people };
  const preferences = [];
  const scopeRows = [
    { scope: 'HOUSEHOLD', personalPersonId: null, ownerKey: 'HOUSEHOLD' },
    ...people.map((person) => ({ scope: 'PERSONAL', personalPersonId: person.id, personalPerson: person, ownerKey: person.id })),
  ];
  const visible = (row, where) => row.householdId === where.householdId
    && (!where.expenseType || row.expenseType === where.expenseType)
    && (!where.scope || row.scope === where.scope)
    && (!where.personalPerson || row.personalPerson?.linkedUserId === where.personalPerson.linkedUserId)
    && (!where.OR || row.scope === 'HOUSEHOLD' || row.personalPerson?.linkedUserId === where.OR[1].personalPerson.linkedUserId);
  const invoices = scopeRows.map((scope, index) => ({
    id: id(10 + index), householdId, categoryId, category, ...scope,
    amountCents: 10_000, periodStart: '2026-01-01', periodEnd: '2026-01-31',
  }));
  const months = scopeRows.map((scope, index) => ({
    id: id(20 + index), householdId, categoryId, category, ...scope,
    year: 2020, month: 1, entryMode: 'SUMMARY', summaryAmountCents: 10_000,
  }));
  const database = {
    householdUserAccess: { findFirst: vi.fn(({ where }) => Promise.resolve(where.householdId === householdId ? { role: 'MEMBER', household } : null)) },
    household: { findUnique: vi.fn().mockResolvedValue(household) },
    category: { findFirst: vi.fn(({ where }) => Promise.resolve(where.id === categoryId && where.householdId === householdId ? category : null)) },
    householdPerson: { findFirst: vi.fn(({ where }) => Promise.resolve(people.find((person) => person.id === where.id && person.householdId === where.householdId) ?? null)) },
    recurringExpense: { findMany: vi.fn().mockResolvedValue([]) },
    utilityInvoice: { findMany: vi.fn(({ where }) => Promise.resolve(invoices.filter((row) => visible(row, where)))) },
    variableExpenseMonth: { findMany: vi.fn(({ where }) => Promise.resolve(months.filter((row) => visible(row, where)))) },
    oneTimeExpense: {
      findFirst: vi.fn().mockResolvedValue({ id: id(30), categoryId, scope: 'HOUSEHOLD', personalPersonId: null, applySafetyMargin: true }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(({ data }) => Promise.resolve({ id: id(30), ...data })),
      update: vi.fn(({ data }) => Promise.resolve({ id: id(30), applySafetyMargin: true, ...data })),
    },
    budgetMarginPreference: {
      findMany: vi.fn(({ where }) => Promise.resolve(preferences.filter((row) => visible(row, where)))),
      upsert: vi.fn(({ where, create, update }) => {
        const key = where.householdId_expenseType_categoryId_ownerKey;
        let item = preferences.find((row) => Object.entries(key).every(([field, value]) => row[field] === value));
        if (item) Object.assign(item, update);
        else {
          item = { id: crypto.randomUUID(), ...create, category, personalPerson: people.find((person) => person.id === create.personalPersonId) ?? null };
          preferences.push(item);
        }
        return Promise.resolve(item);
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  database.$transaction = vi.fn((operation) => operation(database));
  const authenticate = vi.fn((req, res, next) => {
    if (req.headers['x-unauthenticated']) return res.sendStatus(401);
    req.auth = { userId: req.headers['x-user'] ?? userA };
    return next();
  });
  const requireCsrf = vi.fn((req, res, next) => req.headers['x-invalid-csrf'] ? res.sendStatus(403) : next());
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({ prisma: database, authenticate, requireCsrf }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 400).json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message }));
  return { app, database, preferences, people, authenticate, requireCsrf, invoices, months };
}

describe('API de preferencias de margen', () => {
  it('GET vacío no crea preferencias; PUT es idempotente, transaccional y auditado', async () => {
    const { app, database, preferences } = fixture();
    expect((await request(app).get(route).expect(200)).body.data).toEqual([]);
    const enabled = await request(app).put(route).send(common).expect(200);
    expect(enabled.body.data).toMatchObject({ ownerKey: 'HOUSEHOLD', applySafetyMargin: true, effectiveMarginBps: 1_500, marginSource: 'CATEGORY' });
    const disabled = await request(app).put(route).send({ ...common, applySafetyMargin: false }).expect(200);
    expect(disabled.body.data.id).toBe(enabled.body.data.id);
    expect(disabled.body.data.effectiveMarginBps).toBe(0);
    expect(preferences).toHaveLength(1);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(database.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorUserId: userA, resourceType: 'BudgetMarginPreference', metadata: expect.objectContaining({ applySafetyMargin: false }) }) });
  });

  it('común y dos personas tienen preferencias independientes sin exponer la otra persona', async () => {
    const { app, database, preferences } = fixture();
    await request(app).put(route).send(common).expect(200);
    await request(app).put(route).send({ ...common, scope: 'PERSONAL', personalPersonId: personA, applySafetyMargin: false }).expect(200);
    await request(app).put(route).set('x-user', userB).send({ ...common, scope: 'PERSONAL', personalPersonId: personB }).expect(200);
    await request(app).put(route).send({ ...common, expenseType: 'VARIABLE', applySafetyMargin: false }).expect(200);
    expect(preferences).toHaveLength(4);
    const rowsA = (await request(app).get(`${route}?expenseType=INVOICE`).expect(200)).body.data;
    const rowsB = (await request(app).get(`${route}?expenseType=INVOICE`).set('x-user', userB).expect(200)).body.data;
    expect(rowsA.map((row) => [row.ownerKey, row.applySafetyMargin])).toEqual([['HOUSEHOLD', true], [personA, false]]);
    expect(rowsB.map((row) => row.ownerKey)).toEqual(['HOUSEHOLD', personB]);
    expect(database.budgetMarginPreference.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { householdId, expenseType: 'INVOICE', OR: [{ scope: 'HOUSEHOLD' }, { scope: 'PERSONAL', personalPerson: { linkedUserId: userB } }] } }));
  });

  it.each([
    { scope: 'HOUSEHOLD', personalPersonId: personA },
    { scope: 'PERSONAL', personalPersonId: null },
    { scope: 'PERSONAL', personalPersonId: 'invalid' },
    { expenseType: 'RECURRING' }, { applySafetyMargin: 'true' }, { ownerKey: 'HOUSEHOLD' }, { marginBps: 500 },
  ])('rechaza grupos o cuerpos incoherentes: %j', async (body) => {
    const { app, database } = fixture();
    await request(app).put(route).send({ ...common, ...body }).expect(400);
    expect(database.budgetMarginPreference.upsert).not.toHaveBeenCalled();
  });

  it('rechaza categorías de otro hogar antes de escribir', async () => {
    const { app, database } = fixture();
    await request(app).put(route).send({ ...common, categoryId: id(99) }).expect(404);
    expect(database.category.findFirst).toHaveBeenCalledWith({ where: { id: id(99), householdId, archivedAt: null } });
    expect(database.budgetMarginPreference.upsert).not.toHaveBeenCalled();
  });

  it.each([personB, id(99)])('no configura personas ajenas o de otro hogar (%s)', async (personId) => {
    const { app, database } = fixture();
    await request(app).put(route).send({ ...common, scope: 'PERSONAL', personalPersonId: personId }).expect(404);
    expect(database.budgetMarginPreference.upsert).not.toHaveBeenCalled();
  });

  it('rechaza la persona propia inactiva', async () => {
    const { app, people } = fixture();
    people[0].isActive = false;
    await request(app).put(route).send({ ...common, scope: 'PERSONAL', personalPersonId: personA }).expect(404);
  });

  it('requiere sesión, CSRF y acceso al hogar tanto en lectura como escritura', async () => {
    const { app, database } = fixture();
    await request(app).get(route).set('x-unauthenticated', '1').expect(401);
    await request(app).put(route).set('x-unauthenticated', '1').send(common).expect(401);
    await request(app).put(route).set('x-invalid-csrf', '1').send(common).expect(403);
    database.householdUserAccess.findFirst.mockResolvedValue(null);
    await request(app).get(route).expect(404);
    await request(app).put(route).send(common).expect(404);
    expect(database.budgetMarginPreference.upsert).not.toHaveBeenCalled();
  });

  it.each([['INVOICE', 'invoices'], ['VARIABLE', 'variable-expenses']])('%s: estadísticas y carga financiera comparten preferencias; no cambia el histórico', async (expenseType, resource) => {
    const { app, database, invoices, months } = fixture();
    const historicalBefore = structuredClone({ invoices, months });
    const statsPath = `/api/households/${householdId}/${resource}/statistics`;
    const before = (await request(app).get(statsPath).expect(200)).body.data;
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.effectiveMarginBps === 0 && row.baseCents === row.recommendedCents)).toBe(true);
    await request(app).put(route).send({ ...common, expenseType }).expect(200);
    const after = (await request(app).get(statsPath).expect(200)).body.data;
    expect(after[0].effectiveMarginBps).toBe(1_500);
    expect(after[0].recommendedCents).toBe(Math.round(before[0].baseCents * 1.15));
    expect(after[0].averages).toEqual(before[0].averages);
    expect(after[0].historicalAverageCents).toBe(before[0].historicalAverageCents);
    expect(after[1].effectiveMarginBps).toBe(0);
    const inputs = await loadFinancialInputs(database, householdId, userA);
    expect(inputs.invoiceGroups.map((group) => group.applySafetyMargin)).toEqual([expenseType === 'INVOICE', false]);
    expect(inputs.variableGroups.map((group) => group.applySafetyMargin)).toEqual([expenseType === 'VARIABLE', false]);
    expect({ invoices, months }).toEqual(historicalBefore);
    await request(app).put(route).send({ ...common, expenseType, applySafetyMargin: false }).expect(200);
    expect((await request(app).get(statsPath).expect(200)).body.data).toEqual(before);
  });

  it('POST puntual omite margen por defecto; PATCH preserva el existente si no se envía', async () => {
    const { app, database } = fixture();
    const path = `/api/households/${householdId}/one-time-expenses`;
    const created = await request(app).post(path).send({ name: 'Reparación', categoryId, amountCents: 10_000, expenseDate: '2026-09-17' }).expect(201);
    expect(created.body.data.applySafetyMargin).toBe(false);
    const updated = await request(app).patch(`${path}/${id(30)}`).send({ name: 'Otra reparación' }).expect(200);
    expect(updated.body.data.applySafetyMargin).toBe(true);
    expect(database.oneTimeExpense.update.mock.calls[0][0].data).not.toHaveProperty('applySafetyMargin');
    await request(app).patch(`${path}/${id(30)}`).send({ applySafetyMargin: false }).expect(200);
    expect(database.oneTimeExpense.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ applySafetyMargin: false }) }));
  });
});
