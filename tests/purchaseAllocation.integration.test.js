import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { allocatePurchaseAmount, createPurchaseAllocationSnapshot } from '../src/modules/purchases/purchaseAllocation.js';
import { authenticatedPayment as auth, mutablePayment as write, paymentsTestApp, purchaseInput } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_ALLOCATION_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_PURCHASE_ALLOCATION_TEST');
const financing = { downPaymentCents: 0, installmentCount: 3, installmentAmountCents: 100, financingTotalCents: 300, firstInstallmentDate: '2026-10-31' };

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Allocation tests only allow local PostgreSQL.');
  const userIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Allocation test', email: `${id}@purchase-allocation.invalid` })) });
      const household = await tx.household.create({ data: { name: 'Allocation test', ownerUserId: userIds[0] } });
      const people = [];
      for (let index = 0; index < userIds.length; index += 1) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId: userIds[index], role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, name: `Person ${index}`, linkedUserId: userIds[index], contributionBps: index === 0 ? 6000 : index === 1 ? 4000 : 0 } }));
      }
      let sequence = 0;
      const adapter = new Proxy(tx, { get: (target, key) => key === '$transaction' ? async (callback) => {
        const savepoint = `allocation_operation_${sequence++}`;
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
      } : Reflect.get(target, key) });
      const app = paymentsTestApp(adapter);
      const base = `/api/households/${household.id}/purchases`;
      const create = async (input = {}) => (await write(request(app).post(base), userIds[0]).send({ ...purchaseInput, totalCents: 300, paymentMethod: 'FINANCED', financing, ...input }).expect(201)).body.data;
      const pay = async (purchase, installment, input = {}) => (await write(request(app).post(`${base}/${purchase.id}/installments/${installment.id}/pay`), userIds[0]).send({ actualAmountCents: installment.expectedAmountCents, paidAt: '2026-09-17', ...input }).expect(200)).body.data;
      await operation(tx, { app, adapter, base, userIds, people, household, create, pay });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 45_000 });
  } catch (error) { if (error !== rollback) throw error; }
  expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('historical purchase allocation and ordered payments (PostgreSQL rollback)', () => {
  it('captures explicit upfront ownership, retains it through ownership and amount/date corrections, and clears only on confirmed reset', async () => fixture(async (tx, { create, app, base, people, userIds }) => {
    const purchase = await create({ paymentMethod: 'UPFRONT', financing: null, paymentDate: '2026-09-16', paidAmountCents: 300, ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const original = (await tx.purchase.findUnique({ where: { id: purchase.id } })).paymentAllocationSnapshot;
    expect(original.allocations[0]).toMatchObject({ personalPersonId: people[0].id, linkedUserId: userIds[0] });
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ ownershipType: 'HOUSEHOLD' }).expect(200);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ paidAmountCents: 320, paymentDate: '2026-09-17' }).expect(200);
    expect((await tx.purchase.findUnique({ where: { id: purchase.id } })).paymentAllocationSnapshot).toEqual(original);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ paymentDate: null, paidAmountCents: null }).expect(409);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ paymentDate: null, paidAmountCents: null, confirmPaymentReset: true }).expect(200);
    expect((await tx.purchase.findUnique({ where: { id: purchase.id } })).paymentAllocationSnapshot).toBeNull();
    const audit = await tx.auditLog.findFirst({ where: { resourceId: purchase.id, action: 'PURCHASE_PAYMENT_CHANGED' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata.before.allocationSnapshots.upfront).toEqual(original);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ paymentDate: '2026-09-17', paidAmountCents: 300 }).expect(200);
    expect((await tx.purchase.findUnique({ where: { id: purchase.id } })).paymentAllocationSnapshot.ownershipType).toBe('HOUSEHOLD');
  }));

  it('keeps entry allocation historical while unpaid installments use the new ownership', async () => fixture(async (tx, { create, app, base, people, userIds }) => {
    const purchase = await create({ totalCents: 500, financing: { ...financing, downPaymentCents: 200, downPaymentPaidAt: '2026-09-17' }, ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const original = (await tx.purchaseFinancing.findUnique({ where: { id: purchase.financing.id } })).downPaymentAllocationSnapshot;
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ ownershipType: 'HOUSEHOLD' }).expect(200);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ financing: { downPaymentPaidAt: '2026-09-16', provider: 'Corrected entity' } }).expect(200);
    expect((await tx.purchaseFinancing.findUnique({ where: { id: purchase.financing.id } })).downPaymentAllocationSnapshot).toEqual(original);
    const planned = await tx.purchaseInstallment.findMany({ where: { purchaseFinancingId: purchase.financing.id }, select: { paymentAllocationSnapshot: true } });
    expect(planned).toHaveLength(3);
    expect(planned.every((installment) => installment.paymentAllocationSnapshot === null)).toBe(true);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ financing: { downPaymentPaidAt: null }, confirmPaymentReset: true }).expect(200);
    expect((await tx.purchaseFinancing.findUnique({ where: { id: purchase.financing.id } })).downPaymentAllocationSnapshot).toBeNull();
  }));

  it('blocks a later installment, allows early payment of the first, and enables the next', async () => fixture(async (tx, { create, app, base, userIds, pay }) => {
    let purchase = await create();
    expect(purchase.financing.installments.map((row) => row.canRegisterPayment)).toEqual([true, false, false]);
    const [first, second] = purchase.financing.installments;
    const blocked = await write(request(app).post(`${base}/${purchase.id}/installments/${second.id}/pay`), userIds[0]).send({ actualAmountCents: 100, paidAt: '2026-09-17' }).expect(409);
    expect(blocked.body.code).toBe('PURCHASE_INSTALLMENT_OUT_OF_ORDER');
    purchase = await pay(purchase, first, { actualAmountCents: 105 });
    expect(purchase.financing.installments.map((row) => row.canRegisterPayment)).toEqual([false, true, false]);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot.ownershipType).toBe('HOUSEHOLD');
    expect(JSON.stringify(purchase)).not.toContain('AllocationSnapshot');
  }));

  it('retains SPLIT paid weights and applies changed weights only to subsequent payments', async () => fixture(async (tx, { create, app, base, userIds, people, pay }) => {
    let purchase = await create({ ownershipType: 'SPLIT', shares: [{ householdPersonId: people[0].id, shareBps: 6000 }, { householdPersonId: people[1].id, shareBps: 4000 }] });
    const [first, second] = purchase.financing.installments;
    purchase = await pay(purchase, first, { actualAmountCents: 105 });
    const historical = (await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot;
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ shares: [{ householdPersonId: people[0].id, shareBps: 8000 }, { householdPersonId: people[1].id, shareBps: 2000 }] }).expect(200);
    await write(request(app).patch(`${base}/${purchase.id}/installments/${first.id}/payment`), userIds[0]).send({ actualAmountCents: 110, paidAt: '2026-09-16' }).expect(200);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot).toEqual(historical);
    expect(allocatePurchaseAmount(110, historical).find((row) => row.personalPersonId === people[0].id).amountCents).toBe(66);
    await pay(purchase, second);
    const future = (await tx.purchaseInstallment.findUnique({ where: { id: second.id } })).paymentAllocationSnapshot;
    expect(future.allocations.find((row) => row.personalPersonId === people[0].id).shareBps).toBe(8000);
    const audit = await tx.auditLog.findFirst({ where: { resourceId: first.id, action: 'PURCHASE_INSTALLMENT_CORRECTED' } });
    expect(audit.metadata.before.paymentAllocationSnapshot).toEqual(historical);
    expect(audit.metadata.after.paymentAllocationSnapshot).toEqual(historical);
  }));

  it('requires explicit reversal, clears the snapshot, and captures current ownership on a later real payment', async () => fixture(async (tx, { create, app, base, userIds, people, pay }) => {
    let purchase = await create({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const first = purchase.financing.installments[0];
    purchase = await pay(purchase, first);
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ ownershipType: 'HOUSEHOLD' }).expect(200);
    await write(request(app).delete(`${base}/${purchase.id}/installments/${first.id}/payment`), userIds[0]).send({}).expect(400);
    await write(request(app).delete(`${base}/${purchase.id}/installments/${first.id}/payment`), userIds[0]).send({ confirm: true }).expect(200);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot).toBeNull();
    await pay(purchase, first);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot.ownershipType).toBe('HOUSEHOLD');
  }));

  it('keeps historical identities even if a person is relinked later and after archiving', async () => fixture(async (tx, { create, app, base, userIds, people, pay }) => {
    let purchase = await create({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const first = purchase.financing.installments[0];
    purchase = await pay(purchase, first);
    await tx.householdPerson.update({ where: { id: people[0].id }, data: { linkedUserId: null } });
    const row = await tx.purchaseInstallment.findUnique({ where: { id: first.id } });
    expect(row.paymentAllocationSnapshot.allocations[0].linkedUserId).toBe(userIds[0]);
    await tx.householdPerson.update({ where: { id: people[0].id }, data: { linkedUserId: userIds[0] } });
    await write(request(app).delete(`${base}/${purchase.id}`), userIds[0]).expect(200);
    await auth(request(app).get(`${base}/${purchase.id}`), userIds[0]).expect(404);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).paymentAllocationSnapshot).toEqual(row.paymentAllocationSnapshot);
  }));

  it('rolls back payment and captured allocation when audit insertion fails', async () => fixture(async (tx, { create, adapter, base, userIds }) => {
    const purchase = await create();
    const first = purchase.financing.installments[0];
    const failing = new Proxy(adapter, { get: (target, key) => key === 'auditLog' ? { create: async () => { throw new Error('audit unavailable'); } }
      : key === '$transaction' ? (operation) => target.$transaction(() => operation(failing)) : Reflect.get(target, key) });
    const app = paymentsTestApp(failing);
    await write(request(app).post(`${base}/${purchase.id}/installments/${first.id}/pay`), userIds[0]).send({ actualAmountCents: 100, paidAt: '2026-09-17' }).expect(500);
    expect(await tx.purchaseInstallment.findUnique({ where: { id: first.id } })).toMatchObject({ status: 'PLANNED', paymentAllocationSnapshot: null, actualAmountCents: null });
  }));

  it('SQL constraints reject a PAID installment without a snapshot', async () => fixture(async (tx, { create }) => {
    const purchase = await create();
    await tx.$executeRawUnsafe('SAVEPOINT invalid_allocation');
    await expect(tx.purchaseInstallment.update({ where: { id: purchase.financing.installments[0].id }, data: { status: 'PAID', actualAmountCents: 100, paidAt: new Date('2026-09-17') } })).rejects.toThrow();
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_allocation');
  }));

  it('backfills legacy confirmed payments using current ownership without inventing evidence (isolated temporary tables)', async () => fixture(async (tx, { household, people, userIds }) => {
    // Temporary shadow tables isolate the migration statement itself from every
    // real user row. The temporary function and all fixtures roll back.
    for (const sql of [
      'CREATE TEMP TABLE "Purchase" ("id" UUID, "householdId" UUID, "ownershipType" TEXT, "personalPersonId" UUID, "paymentMethod" TEXT, "paymentDate" DATE, "paidAmountCents" INTEGER, "paymentAllocationSnapshot" JSONB) ON COMMIT DROP',
      'CREATE TEMP TABLE "HouseholdPerson" ("id" UUID, "linkedUserId" UUID) ON COMMIT DROP',
      'CREATE TEMP TABLE "PurchaseShare" ("purchaseId" UUID, "householdPersonId" UUID, "shareBps" INTEGER) ON COMMIT DROP',
      'CREATE TEMP TABLE "PurchaseFinancing" ("id" UUID, "purchaseId" UUID, "downPaymentPaidAt" DATE, "downPaymentAllocationSnapshot" JSONB) ON COMMIT DROP',
      'CREATE TEMP TABLE "PurchaseInstallment" ("id" UUID, "purchaseFinancingId" UUID, "status" TEXT, "actualAmountCents" INTEGER, "paidAt" DATE, "paymentAllocationSnapshot" JSONB) ON COMMIT DROP',
    ]) await tx.$executeRawUnsafe(sql);
    const paidId = crypto.randomUUID(); const unpaidId = crypto.randomUUID(); const financingId = crypto.randomUUID();
    await tx.$executeRaw`INSERT INTO pg_temp."HouseholdPerson" VALUES (${people[0].id}::uuid, ${userIds[0]}::uuid)`;
    await tx.$executeRaw`INSERT INTO pg_temp."Purchase" VALUES (${paidId}::uuid, ${household.id}::uuid, 'PERSONAL', ${people[0].id}::uuid, 'UPFRONT', DATE '2026-09-16', 300, NULL), (${unpaidId}::uuid, ${household.id}::uuid, 'HOUSEHOLD', NULL, 'UPFRONT', NULL, NULL, NULL)`;
    await tx.$executeRaw`INSERT INTO pg_temp."PurchaseFinancing" VALUES (${financingId}::uuid, ${paidId}::uuid, DATE '2026-09-16', NULL)`;
    await tx.$executeRaw`INSERT INTO pg_temp."PurchaseInstallment" VALUES (${crypto.randomUUID()}::uuid, ${financingId}::uuid, 'PAID', 100, DATE '2026-09-16', NULL), (${crypto.randomUUID()}::uuid, ${financingId}::uuid, 'PLANNED', NULL, NULL, NULL)`;
    const migration = await readFile(new URL('../prisma/migrations/20260917233000_purchase_financial_allocations/migration.sql', import.meta.url), 'utf8');
    const migrationFunction = migration.slice(migration.indexOf('CREATE FUNCTION purchase_allocation_snapshot_for_migration'), migration.indexOf('UPDATE "Purchase"'));
    await tx.$executeRawUnsafe(migrationFunction.replaceAll('purchase_allocation_snapshot_for_migration', 'pg_temp.purchase_allocation_snapshot_for_migration'));
    const updates = migration.slice(migration.indexOf('UPDATE "Purchase"'), migration.indexOf('DROP FUNCTION purchase_allocation_snapshot_for_migration')).trim().split(';').filter((statement) => statement.trim());
    for (const statement of updates) await tx.$executeRawUnsafe(statement.replaceAll('purchase_allocation_snapshot_for_migration', 'pg_temp.purchase_allocation_snapshot_for_migration'));
    const rows = await tx.$queryRaw`SELECT * FROM pg_temp."Purchase"`;
    const paid = rows.find((row) => row.id === paidId);
    expect(paid).toMatchObject({ paidAmountCents: 300, paymentDate: new Date('2026-09-16') });
    expect(paid.paymentAllocationSnapshot).toEqual(createPurchaseAllocationSnapshot({ householdId: household.id, ownershipType: 'PERSONAL', personalPersonId: people[0].id, personalPerson: { linkedUserId: userIds[0] } }));
    expect(rows.find((row) => row.id === unpaidId)).toMatchObject({ paymentDate: null, paidAmountCents: null, paymentAllocationSnapshot: null });
    const installments = await tx.$queryRaw`SELECT * FROM pg_temp."PurchaseInstallment"`;
    expect(installments.find((row) => row.status === 'PAID').paymentAllocationSnapshot).toEqual(paid.paymentAllocationSnapshot);
    expect(installments.find((row) => row.status === 'PLANNED')).toMatchObject({ actualAmountCents: null, paidAt: null, paymentAllocationSnapshot: null });
    expect((await tx.$queryRaw`SELECT * FROM pg_temp."PurchaseFinancing"`)[0].downPaymentAllocationSnapshot).toEqual(paid.paymentAllocationSnapshot);
  }));
});
