import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createPurchasesRouter } from '../src/modules/purchases/index.js';
import { createFinanceRouter } from '../src/modules/finance/index.js';

// Local PostgreSQL opt-in only. Fixtures and successful requests are rolled back.
// A savepoint models each HTTP transaction; flushing deferred constraints also
// tests invariants that would otherwise only run at COMMIT, not at rollback.
const enabled = process.env.PURCHASES_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_PURCHASES_TEST');
const baseInput = { merchant: 'Apple Store', purchaseDate: '2026-09-17', totalCents: 99_900, ownershipType: 'HOUSEHOLD', items: [{ name: 'iPhone 17', brand: 'Apple', model: '17', serialNumber: 'ABC123', imei: '123456789012345', warrantyDurationMonths: 36 }] };

function appFor(prisma, userId) {
  const app = express();
  app.use(express.json());
  const dependencies = { prisma, authenticate: (req, _res, next) => { req.auth = { userId }; next(); }, requireCsrf: (_req, _res, next) => next() };
  app.use('/api', createPurchasesRouter(dependencies));
  app.use('/api', createFinanceRouter(dependencies));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? (error.issues ? 400 : 500)).json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message, details: error.issues }));
  return app;
}

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Purchases tests require a local database.');
  const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Purchases test', email: `${id}@purchases.invalid` })) });
      const household = await tx.household.create({ data: { ownerUserId: userIds[0], name: 'Purchases test', safetyMarginBps: 0, currentBalanceCents: 50_000 } });
      const otherHousehold = await tx.household.create({ data: { ownerUserId: userIds[0], name: 'Other purchases test' } });
      const foreign = await tx.householdPerson.create({ data: { householdId: otherHousehold.id, name: 'Outside' } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: ['Pablo', 'Natalia', 'Otro'][index], contributionBps: index === 0 ? 6000 : index === 1 ? 4000 : 0 } }));
      }
      let transactionNumber = 0;
      const adapter = new Proxy(tx, { get: (target, property) => property === '$transaction'
        ? async (callback) => {
          const savepoint = `purchase_operation_${transactionNumber++}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            const result = await callback(adapter);
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            throw error;
          }
        } : Reflect.get(target, property) });
      const apps = userIds.map((id) => appFor(adapter, id));
      const base = `/api/households/${household.id}/purchases`;
      const create = async (input = {}, app = apps[0]) => (await request(app).post(base).send({ ...baseInput, ...input }).expect(201)).body.data;
      await operation(tx, { adapter, household, otherHousehold, foreign, people, userIds, apps, base, create });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchases HTTP API with PostgreSQL', () => {
  it('creates household iPhone example atomically, exposes warranty in detail, omits identifiers from list', async () => fixture(async (tx, { create, apps, base }) => {
    const purchase = await create();
    expect(purchase).toMatchObject({ merchant: 'Apple Store', purchaseDate: '2026-09-17', totalCents: 99_900, ownershipType: 'HOUSEHOLD', personalPersonId: null, shares: [] });
    expect(purchase.items[0]).toMatchObject({ name: 'iPhone 17', quantity: 1, warrantySource: 'DURATION', warrantyDurationMonths: 36, warrantyEndsAt: '2029-09-17' });
    const list = (await request(apps[0]).get(base).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].items[0]).not.toHaveProperty('serialNumber');
    expect(list[0].items[0]).not.toHaveProperty('imei');
    const detail = (await request(apps[0]).get(`${base}/${purchase.id}`).expect(200)).body.data;
    expect(detail.items[0]).toMatchObject({ serialNumber: 'ABC123', imei: '123456789012345' });
    expect(await tx.auditLog.findFirst({ where: { resourceId: purchase.id, action: 'PURCHASE_CREATED' } })).not.toBeNull();
  }));

  it('creates PERSONAL owned by Pablo, visible only to Pablo, including owner privacy policy', async () => fixture(async (_tx, { create, people, apps, base }) => {
    const purchase = await create({ ownershipType: 'PERSONAL', personalPersonId: people[1].id }, apps[1]);
    expect(purchase.personalPerson).toEqual({ id: people[1].id, name: 'Natalia' });
    expect(purchase.personalPerson).not.toHaveProperty('linkedUserId');
    await request(apps[1]).get(`${base}/${purchase.id}`).expect(200);
    for (const actor of [apps[0], apps[2]]) {
      expect((await request(actor).get(base).expect(200)).body.data).toEqual([]);
      await request(actor).get(`${base}/${purchase.id}`).expect(404);
      await request(actor).patch(`${base}/${purchase.id}`).send({ merchant: 'Stolen' }).expect(404);
      await request(actor).delete(`${base}/${purchase.id}`).expect(404);
      await request(actor).post(`${base}/${purchase.id}/items`).send({ name: 'Invisible' }).expect(404);
      await request(actor).patch(`${base}/${purchase.id}/items/${purchase.items[0].id}`).send({ name: 'Invisible' }).expect(404);
      await request(actor).delete(`${base}/${purchase.id}/items/${purchase.items[0].id}`).expect(404);
    }
  }));

  it('SPLIT is visible to participants, never unrelated OWNER, and metadata patches preserve shares', async () => fixture(async (_tx, { create, people, apps, base }) => {
    const shares = [{ householdPersonId: people[1].id, shareBps: 6000 }, { householdPersonId: people[2].id, shareBps: 4000 }];
    const purchase = await create({ ownershipType: 'SPLIT', shares }, apps[1]);
    expect(purchase.personalPersonId).toBeNull();
    expect(purchase.shares.map(({ householdPersonId, shareBps }) => ({ householdPersonId, shareBps }))).toEqual(expect.arrayContaining(shares));
    for (const actor of [apps[1], apps[2]]) await request(actor).get(`${base}/${purchase.id}`).expect(200);
    expect((await request(apps[0]).get(base).expect(200)).body.data).toEqual([]);
    await request(apps[0]).patch(`${base}/${purchase.id}`).send({ merchant: 'Invisible' }).expect(404);
    const edited = (await request(apps[1]).patch(`${base}/${purchase.id}`).send({ merchant: 'Updated', purchaseDate: '2026-10-17' }).expect(200)).body.data;
    expect(edited.shares).toEqual(purchase.shares);
    expect(edited.items[0].warrantyEndsAt).toBe('2029-10-17');
  }));

  it('normalizes all ownership transitions without residual personal person or shares', async () => fixture(async (tx, { create, people, apps, base }) => {
    const purchase = await create();
    const path = `${base}/${purchase.id}`;
    const transitions = [
      { ownershipType: 'PERSONAL', personalPersonId: people[0].id },
      { ownershipType: 'HOUSEHOLD' },
      { ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 4000 }] },
      { ownershipType: 'PERSONAL', personalPersonId: people[0].id },
      { ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 4000 }] },
      { ownershipType: 'HOUSEHOLD' },
    ];
    for (const input of transitions) {
      const result = (await request(apps[0]).patch(path).send(input).expect(200)).body.data;
      expect(result.ownershipType).toBe(input.ownershipType);
      expect(result.personalPersonId).toBe(input.ownershipType === 'PERSONAL' ? people[0].id : null);
      expect(result.shares.length).toBe(input.ownershipType === 'SPLIT' ? 2 : 0);
      expect(await tx.purchaseShare.count({ where: { purchaseId: purchase.id } })).toBe(result.shares.length);
    }
  }));

  it('cross-household people and invalid splits are rejected without incomplete purchases or audits', async () => fixture(async (tx, { foreign, people, apps, base, household }) => {
    for (const invalid of [
      { ownershipType: 'PERSONAL' }, { ownershipType: 'PERSONAL', personalPersonId: foreign.id },
      { ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: foreign.id, shareBps: 4000 }] },
      { ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 3000 }] },
      { ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[0].id, shareBps: 4000 }] },
      { items: [] }, { items: [{ name: 'No warranty', warrantyDurationMonths: -1 }] },
    ]) await request(apps[0]).post(base).send({ ...baseInput, ...invalid }).expect(400);
    expect(await tx.purchase.count({ where: { householdId: household.id } })).toBe(0);
    expect(await tx.auditLog.count({ where: { householdId: household.id } })).toBe(0);
  }));

  it('full UI metadata edits preserve historical ownership and share IDs; new assignment to archived people fails', async () => fixture(async (tx, { create, people, apps, base }) => {
    const shares = [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 4000 }];
    const split = await create({ ownershipType: 'SPLIT', shares });
    const personal = await create({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    await tx.householdPerson.updateMany({ where: { id: { in: people.map((person) => person.id) } }, data: { isActive: false, archivedAt: new Date() } });
    const edited = (await request(apps[0]).patch(`${base}/${split.id}`).send({ merchant: 'Historical edit', ownershipType: 'SPLIT', personalPersonId: null, shares: [...shares].reverse() }).expect(200)).body.data;
    expect(edited.shares).toEqual(split.shares);
    expect(edited.merchant).toBe('Historical edit');
    await request(apps[0]).patch(`${base}/${personal.id}`).send({ merchant: 'Historical edit', ownershipType: 'PERSONAL', personalPersonId: people[0].id, shares: [] }).expect(200);
    await request(apps[0]).patch(`${base}/${personal.id}`).send({ ownershipType: 'PERSONAL', personalPersonId: people[2].id }).expect(400);
    await request(apps[0]).patch(`${base}/${split.id}`).send({ ownershipType: 'SPLIT', shares: shares.map((share) => ({ ...share, shareBps: 5000 })) }).expect(400);
  }));

  it('changing date recalculates only duration warranties; item PATCH preserves omitted warranty and quantity', async () => fixture(async (_tx, { create, apps, base }) => {
    const purchase = await create({ purchaseDate: '2024-01-31', items: [
      { name: 'Duration', quantity: 4, warrantyDurationMonths: 1 },
      { name: 'Explicit', warrantyEndsAt: '2028-01-01', warrantyDurationMonths: 36 },
      { name: 'None' },
    ] });
    const path = `${base}/${purchase.id}`;
    expect(purchase.items.find((item) => item.name === 'Duration').warrantyEndsAt).toBe('2024-02-29');
    const result = (await request(apps[0]).patch(path).send({ purchaseDate: '2025-01-31' }).expect(200)).body.data;
    expect(result.items.find((item) => item.name === 'Duration').warrantyEndsAt).toBe('2025-02-28');
    expect(result.items.find((item) => item.name === 'Explicit')).toMatchObject({ warrantyEndsAt: '2028-01-01', warrantySource: 'EXPLICIT_DATE', warrantyDurationMonths: null });
    expect(result.items.find((item) => item.name === 'None')).toMatchObject({ warrantyStatus: 'NONE', warrantyEndsAt: null, warrantyDaysRemaining: null });
    const item = result.items.find((item) => item.name === 'Duration');
    const metadata = (await request(apps[0]).patch(`${path}/items/${item.id}`).send({ brand: 'Example' }).expect(200)).body.data;
    expect(metadata.items.find((row) => row.id === item.id)).toMatchObject({ quantity: 4, warrantyEndsAt: item.warrantyEndsAt, warrantySource: 'DURATION' });
    const cleared = (await request(apps[0]).patch(`${path}/items/${item.id}`).send({ warrantyDurationMonths: null, warrantyEndsAt: null }).expect(200)).body.data;
    expect(cleared.items.find((row) => row.id === item.id)).toMatchObject({ warrantyStatus: 'NONE', warrantySource: null, warrantyEndsAt: null, warrantyDurationMonths: null });
  }));

  it('product CRUD retains at least one product and never requires item prices to match total', async () => fixture(async (tx, { create, apps, base }) => {
    const purchase = await create();
    const path = `${base}/${purchase.id}`;
    const first = purchase.items[0];
    await request(apps[0]).delete(`${path}/items/${first.id}`).expect(409);
    const added = (await request(apps[0]).post(`${path}/items`).send({ name: 'Cable', priceCents: 1200 }).expect(201)).body.data;
    expect(added.items).toHaveLength(2);
    expect(added.totalCents).toBe(99_900);
    const remaining = (await request(apps[0]).delete(`${path}/items/${first.id}`).expect(200)).body.data;
    expect(remaining.items).toHaveLength(1);
    await request(apps[0]).delete(`${path}/items/${remaining.items[0].id}`).expect(409);
    expect(await tx.purchaseItem.count({ where: { purchaseId: purchase.id } })).toBe(1);
    expect(await tx.auditLog.count({ where: { action: 'PURCHASE_ITEM_CREATED', resourceId: remaining.items[0].id } })).toBe(1);
    expect(await tx.auditLog.count({ where: { action: 'PURCHASE_ITEM_DELETED', resourceId: first.id } })).toBe(1);
  }));

  it('archiving hides list and detail but preserves products and shares, and records audit', async () => fixture(async (tx, { create, apps, people, base }) => {
    const purchase = await create({ ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 4000 }] });
    await request(apps[0]).delete(`${base}/${purchase.id}`).expect(200);
    expect((await request(apps[0]).get(base).expect(200)).body.data).toEqual([]);
    await request(apps[0]).get(`${base}/${purchase.id}`).expect(404);
    expect((await tx.purchase.findUnique({ where: { id: purchase.id } })).archivedAt).not.toBeNull();
    expect(await tx.purchaseItem.count({ where: { purchaseId: purchase.id } })).toBe(1);
    expect(await tx.purchaseShare.count({ where: { purchaseId: purchase.id } })).toBe(2);
    expect(await tx.auditLog.count({ where: { resourceId: purchase.id, action: 'PURCHASE_ARCHIVED' } })).toBe(1);
  }));

  it('creating/assigning to another person is permitted but returns only accessRevoked, never their new private detail', async () => fixture(async (_tx, { create, people, apps, base }) => {
    const privateResult = await create({ ownershipType: 'PERSONAL', personalPersonId: people[1].id });
    expect(privateResult).toEqual({ id: expect.any(String), accessRevoked: true });
    await request(apps[0]).get(`${base}/${privateResult.id}`).expect(404);
    await request(apps[1]).get(`${base}/${privateResult.id}`).expect(200);
    const common = await create();
    const changed = (await request(apps[0]).patch(`${base}/${common.id}`).send({ ownershipType: 'PERSONAL', personalPersonId: people[1].id }).expect(200)).body.data;
    expect(changed).toEqual({ id: common.id, accessRevoked: true });
    await request(apps[0]).get(`${base}/${common.id}`).expect(404);
  }));

  it('purchases never affect budgets, monthly progress, accounts or financial expense tables', async () => fixture(async (tx, { create, apps, household }) => {
    const dashboardPath = `/api/households/${household.id}/dashboard?date=2026-09-17`;
    const before = (await request(apps[0]).get(dashboardPath).expect(200)).body.data;
    await create();
    const after = (await request(apps[0]).get(dashboardPath).expect(200)).body.data;
    expect(after.budget).toEqual(before.budget);
    expect(after.monthlyProgress).toEqual(before.monthlyProgress);
    expect(after.cashCoverage).toEqual(before.cashCoverage);
    expect(after.balanceCents).toBe(before.balanceCents);
    for (const model of ['oneTimeExpense', 'recurringExpense', 'utilityInvoice', 'householdAccount']) {
      expect(await tx[model].count({ where: { householdId: household.id } })).toBe(0);
    }
  }));

  it('list is newest first and household access is rechecked for mutations', async () => fixture(async (tx, { create, apps, base, household, userIds }) => {
    const old = await create({ purchaseDate: '2025-09-17' });
    const newest = await create({ purchaseDate: '2026-09-17' });
    expect((await request(apps[1]).get(base).expect(200)).body.data.map((row) => row.id)).toEqual([newest.id, old.id]);
    await tx.householdUserAccess.update({ where: { householdId_userId: { householdId: household.id, userId: userIds[1] } }, data: { isActive: false, revokedAt: new Date() } });
    await request(apps[1]).get(base).expect(404);
    await request(apps[1]).patch(`${base}/${newest.id}`).send({ merchant: 'No access' }).expect(404);
    await request(apps[1]).post(base).send(baseInput).expect(404);
  }));

  it('a failed audit rolls back purchase and items, not just the response', async () => fixture(async (tx, { adapter, household, userIds, base }) => {
    const failing = new Proxy(adapter, { get: (target, property) => property === '$transaction'
      ? (callback) => adapter.$transaction((inner) => callback(new Proxy(inner, { get: (modelTarget, model) => model === 'auditLog' ? { create: () => { throw new Error('Synthetic audit failure'); } } : Reflect.get(modelTarget, model) })))
      : Reflect.get(target, property) });
    await request(appFor(failing, userIds[0])).post(base).send(baseInput).expect(500);
    expect(await tx.purchase.count({ where: { householdId: household.id } })).toBe(0);
    expect(await tx.purchaseItem.count({ where: { purchase: { householdId: household.id } } })).toBe(0);
  }));

  it('database rejects invalid ownership, foreign people, empty purchase and NULL warranty-source loopholes', async () => fixture(async (tx, { create, foreign, people, household }) => {
    const purchase = await create();
    const reject = async (operation) => {
      await tx.$executeRawUnsafe('SAVEPOINT purchase_invalid');
      let rejected = false;
      try { await operation(); await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); } catch { rejected = true; }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT purchase_invalid');
      expect(rejected).toBe(true);
    };
    await reject(() => tx.purchaseItem.update({ where: { id: purchase.items[0].id }, data: { warrantySource: null, warrantyDurationMonths: null, warrantyEndsAt: new Date('2029-09-17T00:00:00Z') } }));
    await reject(() => tx.purchaseItem.deleteMany({ where: { purchaseId: purchase.id } }));
    await reject(() => tx.purchase.update({ where: { id: purchase.id }, data: { ownershipType: 'PERSONAL', personalPersonId: foreign.id } }));
    await reject(() => tx.purchaseShare.create({ data: { purchaseId: purchase.id, householdPersonId: people[0].id, shareBps: 10000 } }));
    await reject(() => tx.purchase.update({ where: { id: purchase.id }, data: { ownershipType: 'SPLIT' } }));
    await reject(() => tx.purchase.create({ data: { householdId: household.id, purchaseDate: new Date('2026-09-17T00:00:00Z'), totalCents: 0 } }));
  }));
});
