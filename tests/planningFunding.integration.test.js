import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { withPurchaseFinanceFixture } from './helpers/purchaseFinanceFixtures.js';
import { authenticatedPayment as auth, mutablePayment as write } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_FINANCE_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('monthly forecast funding (local PostgreSQL, rollback)', () => {
  it('records additional shared agreements separately, confirms per person and never changes balances or original rows', async () => withPurchaseFinanceFixture(database, async (tx, { app, prefix, userIds, people, household, upfront, dashboard }) => {
    await upfront({ paymentDate: '2026-09-01', paidAmountCents: 10000, totalCents: 10000 });
    const saved = (await write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send({ calculationDate: '2026-09-01', confirmedBalanceCents: 200000,
      confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 10000 })) }).expect(201)).body.data;
    const path = `${prefix}/plannings/${saved.id}`;
    await write(request(app).patch(`${path}/fund`), userIds[0]).send({ scope: 'ALL', expectedVersion: 0 }).expect(200);
    const before = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: true } });
    await upfront({ paymentDate: '2026-09-02', paidAmountCents: 8000, totalCents: 8000 });
    expect((await dashboard('2026-09-01')).planning.extras).toEqual([]);
    const body = { id: crypto.randomUUID(), expectedVersion: 1, amountCents: 8001, reason: 'Reparación imprevista' };
    const preview = (await write(request(app).post(`${path}/extras/preview`), userIds[0]).send({ expectedVersion: 1, amountCents: 8001 }).expect(200)).body.data;
    expect(preview.shares.reduce((sum, item) => sum + item.amountCents, 0)).toBe(8001);
    const agreement = (await write(request(app).post(`${path}/extras`), userIds[0]).send(body).expect(201)).body.data;
    expect(agreement.extraFunding.pendingCents).toBe(8001);
    expect(agreement.fundingStatus).toBe('FUNDED'); // Initial funding remains separate.
    expect(agreement.stateVersion).toBe(2);
    expect(agreement.extras[0].shares).toEqual(preview.shares.map((share) => ({ ...share, confirmedAt: null })));
    expect((await write(request(app).post(`${path}/extras`), userIds[0]).send(body).expect(201)).body.data.stateVersion).toBe(2);
    await write(request(app).post(`${path}/extras`), userIds[0]).send({ ...body, id: crypto.randomUUID() }).expect(409);
    await auth(request(app).get(`${path}/revision-preview`), userIds[0]).expect(409);
    const confirm = { action: 'CONFIRM', expectedVersion: 2, personId: people[0].id };
    await write(request(app).patch(`${path}/extras/${body.id}`), userIds[0]).send({ ...confirm, personId: crypto.randomUUID() }).expect(400);
    await write(request(app).patch(`${path}/extras/${body.id}`), crypto.randomUUID()).send(confirm).expect(404);
    const confirmed = (await write(request(app).patch(`${path}/extras/${body.id}`), userIds[1]).send(confirm).expect(200)).body.data;
    expect(confirmed.extraFunding).toEqual({ agreedCents: 8001, confirmedCents: 4801, pendingCents: 3200 });
    expect(confirmed.contributions.find((item) => item.householdPersonId === people[0].id).totalPendingCents).toBe(0);
    await write(request(app).patch(`${path}/extras/${body.id}`), userIds[0]).send({ action: 'CANCEL', expectedVersion: 3, reason: 'No hace falta' }).expect(409);
    expect((await dashboard('2026-09-01')).planning.extraFunding.pendingCents).toBe(3200);
    await write(request(app).patch(`${path}/extras/${body.id}`), userIds[0]).send({ action: 'REVOKE', expectedVersion: 3, personId: people[0].id, reason: 'Se marcó por error' }).expect(200);
    const cancelled = (await write(request(app).patch(`${path}/extras/${body.id}`), userIds[0]).send({ action: 'CANCEL', expectedVersion: 4, reason: 'Usaremos el colchón' }).expect(200)).body.data;
    expect(cancelled.extraFunding).toEqual({ agreedCents: 0, confirmedCents: 0, pendingCents: 0 });
    expect(cancelled.contributions.every((item) => item.totalPendingCents === 0)).toBe(true);
    await write(request(app).patch(`${path}/extras/${body.id}`), userIds[0]).send({ action: 'CONFIRM', expectedVersion: 5, personId: people[0].id }).expect(409);
    const after = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: true } });
    expect(after.contributions).toEqual(before.contributions);
    expect(after.breakdown.budget).toEqual(before.breakdown.budget);
    expect(after.breakdown.extras[0].events).toHaveLength(3);
    expect((await tx.household.findUnique({ where: { id: household.id } })).currentBalanceCents).toBe(200000);
  }));

  it('previews revisions, rejects stale previews, preserves originals and accounts, and funds the revised amounts', async () => withPurchaseFinanceFixture(database, async (tx, { app, prefix, userIds, people, household, upfront, read, dashboard }) => {
    await upfront({ paymentDate: '2026-09-01', paidAmountCents: 10000, totalCents: 10000 });
    await upfront({ paymentDate: '2026-09-01', paidAmountCents: 5000, totalCents: 5000, ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const saved = (await write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send({ calculationDate: '2026-09-01', confirmedBalanceCents: 200000,
      confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 10000 })) }).expect(201)).body.data;
    const rawBefore = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: { orderBy: { personName: 'asc' } } } });
    const path = `/plannings/${saved.id}`;
    await upfront({ paymentDate: '2026-09-02', paidAmountCents: 8000, totalCents: 8000 });
    const preview = await read(`${path}/revision-preview`);
    expect(preview.householdBudgetCents).toBe(18000);
    const revise = (data) => write(request(app).post(`${prefix}${path}/revisions`), userIds[0]).send({ expectedVersion: data.expectedVersion, previewFingerprint: data.previewFingerprint, reason: 'Faltaba una compra' });
    const common = (await write(request(app).patch(`${prefix}${path}/fund`), userIds[0]).send({ scope: 'HOUSEHOLD', expectedVersion: 0 }).expect(200)).body.data;
    expect(common.stateVersion).toBe(1);
    expect((await revise(preview).expect(409)).body.code).toBe('PLANNING_CHANGED');
    const undo = (await write(request(app).patch(`${prefix}${path}/fund`), userIds[0]).send({ scope: 'HOUSEHOLD', action: 'REVOKE', expectedVersion: 1, reason: 'Se confirmó sin transferir' }).expect(200)).body.data;
    expect(undo.contributions.find((item) => item.householdPersonId === people[0].id).funding.pendingCents).toBe(11000);
    const preview2 = await read(`${path}/revision-preview`);
    await upfront({ paymentDate: '2026-09-03', paidAmountCents: 2000, totalCents: 2000 });
    expect((await revise(preview2).expect(409)).body.code).toBe('PLANNING_CHANGED');
    const preview3 = await read(`${path}/revision-preview`);
    const revised = (await revise(preview3).expect(201)).body.data;
    expect(revised.stateVersion).toBe(3);
    expect(revised.revision).toBe(1);
    expect(revised.householdBudgetCents).toBe(20000);
    expect(revised.revisionHistory.map((item) => item.householdBudgetCents)).toEqual([10000, 20000]);
    const rawAfter = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: { orderBy: { personName: 'asc' } } } });
    expect(rawAfter.householdBudgetCents).toBe(rawBefore.householdBudgetCents);
    expect(rawAfter.contributions).toEqual(rawBefore.contributions);
    expect(rawAfter.breakdown.budget).toEqual(rawBefore.breakdown.budget);
    expect(rawAfter.breakdown.fundingEvents).toHaveLength(2);
    expect((await dashboard('2026-09-01')).planning.householdBudgetCents).toBe(20000);
    const funded = (await write(request(app).patch(`${prefix}${path}/fund`), userIds[0]).send({ scope: 'ALL', expectedVersion: 3 }).expect(200)).body.data;
    expect(funded.contributions.find((item) => item.householdPersonId === people[0].id).funding.confirmedCents).toBe(17000);
    expect((await tx.household.findUnique({ where: { id: household.id } })).currentBalanceCents).toBe(200000);
    expect(await tx.auditLog.count({ where: { resourceId: saved.id, resourceType: 'MonthlyPlanning' } })).toBe(5);
    await write(request(app).post(`${prefix}${path}/revisions`), crypto.randomUUID()).send({ expectedVersion: 4, previewFingerprint: preview3.previewFingerprint, reason: 'Sin permiso' }).expect(404);
  }));

  it('freezes month, refuses overwrite and independently confirms common and own personal funds idempotently', async () => withPurchaseFinanceFixture(database, async (tx, { app, prefix, userIds, people, household, upfront, dashboard }) => {
    await upfront({ paymentDate: '2026-09-01', paidAmountCents: 10000, totalCents: 10000 });
    await upfront({ paymentDate: '2026-09-30', paidAmountCents: 5000, totalCents: 5000, ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const body = { calculationDate: '2026-09-29', confirmedBalanceCents: 200000,
      confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 10000 })) };
    const prepare = () => write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send(body);
    const saved = (await prepare().expect(201)).body.data;
    expect(saved.calculationDate).toContain('2026-09-01');
    expect(saved.contributions.find((c) => c.personName === 'Pablo')).toMatchObject({ totalRecommendedCents: 11000, funding: { pendingCents: 11000 } });
    await upfront({ paymentDate: '2026-09-15', paidAmountCents: 8000, totalCents: 8000 });
    const changed = await dashboard('2026-09-29');
    expect(changed.planning.householdBudgetCents).toBe(10000);
    expect(changed.planning.budgetComparison.householdDifferenceCents).toBe(8000);
    expect(changed.budget.householdBudgetCents).toBe(18000);
    expect((await prepare().expect(409)).body.code).toBe('MONTH_ALREADY_PREPARED');
    const beforeFunding = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: true } });
    const fund = (scope, user = 0) => write(request(app).patch(`${prefix}/plannings/${saved.id}/fund`), userIds[user]).send({ scope });
    const common = (await fund('HOUSEHOLD').expect(200)).body.data;
    expect(common.fundingStatus).toBe('PREPARED');
    expect(common.contributions.find((c) => c.personName === 'Pablo').funding).toMatchObject({ confirmedCents: 6000, pendingCents: 5000 });
    const own = (await fund('PERSONAL').expect(200)).body.data;
    expect(own.fundingStatus).toBe('FUNDED');
    expect(own.contributions.every((c) => c.funding.pendingCents === 0)).toBe(true);
    const funded = await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: true } });
    await fund('PERSONAL').expect(200);
    expect(await tx.monthlyPlanning.findUnique({ where: { id: saved.id }, include: { contributions: true } })).toEqual(funded);
    expect(funded.contributions).toEqual(beforeFunding.contributions);
    expect(funded.breakdown.budget).toEqual(beforeFunding.breakdown.budget);
    expect((await tx.household.findUnique({ where: { id: household.id } })).currentBalanceCents).toBe(200000);
  }));

  it('cannot confirm another identity or access a different household, and keeps legacy funded plans unchanged', async () => withPurchaseFinanceFixture(database, async (tx, { app, prefix, userIds, people, upfront }) => {
    await upfront({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const saved = (await write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send({ calculationDate: '2026-09-01', confirmedBalanceCents: 0,
      confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 0 })) }).expect(201)).body.data;
    const endpoint = `${prefix}/plannings/${saved.id}/fund`;
    const other = (await write(request(app).patch(endpoint), userIds[1]).send({ scope: 'PERSONAL' }).expect(200)).body.data;
    expect(other.fundingStatus).toBe('PREPARED');
    const raw = await tx.monthlyPlanning.findUnique({ where: { id: saved.id } });
    expect(raw.breakdown.funding.personal.map((c) => c.personId)).toEqual([people[1].id]);
    await write(request(app).patch(endpoint), userIds[0]).send({ scope: 'PERSONAL', personId: people[1].id }).expect(400);
    await write(request(app).patch(endpoint), crypto.randomUUID()).send({ scope: 'ALL' }).expect(404);
    await tx.monthlyPlanning.update({ where: { id: saved.id }, data: { breakdown: { budget: raw.breakdown.budget }, fundingStatus: 'FUNDED', fundedAt: new Date('2026-09-01') } });
    const legacy = await tx.monthlyPlanning.findUnique({ where: { id: saved.id } });
    await write(request(app).patch(endpoint), userIds[0]).send({ scope: 'PERSONAL' }).expect(403);
    await write(request(app).patch(endpoint), userIds[0]).send({}).expect(200);
    expect(await tx.monthlyPlanning.findUnique({ where: { id: saved.id } })).toEqual(legacy);
  }));
});
