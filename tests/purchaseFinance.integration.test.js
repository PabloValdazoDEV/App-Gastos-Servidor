import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { withPurchaseFinanceFixture } from './helpers/purchaseFinanceFixtures.js';
import { authenticatedPayment as auth, mutablePayment as write, financingInput } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_FINANCE_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const fixture = (operation) => withPurchaseFinanceFixture(database, operation);
const septemberFinancing = { ...financingInput, installmentAmountCents: 5000, financingTotalCents: 100_000, firstInstallmentDate: '2026-09-17' };
afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchase financial source integration (local PostgreSQL, full rollback)', () => {
  it('A: upfront uses explicit payment month and actual cents without safety margin or shadow expenses', async () => fixture(async (tx, { upfront, dashboard, calendar, household }) => {
    const purchase = await upfront({ purchaseDate: '2026-08-20', paidAmountCents: 90_000 });
    expect((await dashboard('2026-08-20')).monthlyProgress.common).toMatchObject({ budgetCents: 0, usedCents: 0 });
    const result = await dashboard();
    expect(result.monthlyProgress.common).toMatchObject({ budgetCents: 90_000, usedCents: 90_000, remainingCents: 0 });
    expect(result.budget.lines).toHaveLength(1);
    expect(result.budget.lines[0]).toMatchObject({ type: 'PURCHASE', sourceType: 'PURCHASE_UPFRONT', purchaseId: purchase.id, name: 'Móvil · Al contado', amountCents: 90_000, baseCents: 90_000, effectiveMarginBps: 0 });
    expect((await calendar()).events[0]).toMatchObject({ sourceType: 'PURCHASE_UPFRONT', status: 'PAID', amountCents: 90_000, canRegisterPayment: false });
    for (const model of ['oneTimeExpense', 'recurringExpense', 'utilityInvoice']) expect(await tx[model].count({ where: { householdId: household.id } })).toBe(0);
    expect(await tx.expensePayment.count({ where: { recurringExpense: { householdId: household.id } } })).toBe(0);
  }));

  it('B/C: deposit plus scheduled installments, cash coverage, actual deviation and natural month boundaries', async () => fixture(async (_tx, { create, dashboard, pay }) => {
    const purchase = await create({ financing: septemberFinancing });
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 25_000, usedCents: 0, remainingCents: 25_000 });
    expect((await dashboard()).cashCoverage.common).toMatchObject({ remainingBudgetCents: 25_000, shortfallCents: 15_000 });
    expect((await dashboard('2026-10-17')).monthlyProgress.common).toMatchObject({ budgetCents: 5000, usedCents: 0 });
    await pay(purchase, 1, { actualAmountCents: 5200 });
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 25_000, usedCents: 5200, remainingCents: 19_800 });
  }));

  it('a paid deposit counts once and actual above expected produces overbudget', async () => fixture(async (_tx, { create, dashboard, pay }) => {
    const purchase = await create({ financing: { ...septemberFinancing, downPaymentPaidAt: '2026-09-17' } });
    await pay(purchase, 1, { actualAmountCents: 5200 });
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 25_000, usedCents: 25_200, overBudgetCents: 200, remainingCents: 0 });
  }));

  it('Calendar enables only the first globally pending installment, including early payment outside the requested month', async () => fixture(async (_tx, { app, base, userIds, create, calendar, dashboard, pay }) => {
    const purchase = await create();
    const october = (await calendar('2026-10-01')).events[0];
    expect(october).toMatchObject({ sourceType: 'PURCHASE_INSTALLMENT', sequence: 1, canRegisterPayment: true, purchaseId: purchase.id });
    expect((await calendar('2026-11-01')).events[0].canRegisterPayment).toBe(false);
    await write(request(app).post(`${base}/${purchase.id}/installments/${purchase.financing.installments[1].id}/pay`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(409);
    await pay(purchase);
    expect((await calendar('2026-10-01')).events[0]).toMatchObject({ status: 'PAID', canRegisterPayment: false, canEditPayment: true });
    expect((await calendar('2026-11-01')).events[0].canRegisterPayment).toBe(true);
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 20_000, usedCents: 5500 });
    expect((await dashboard('2026-10-17')).monthlyProgress.common).toMatchObject({ budgetCents: 5500, usedCents: 0 });
  }));

  it('D: SPLIT sends only exact viewer allocations across budget/progress/calendar and OWNER has no override', async () => fixture(async (_tx, { create, dashboard, calendar, people, pay }) => {
    const purchase = await create({ totalCents: 20_000, ownershipType: 'SPLIT', shares: [{ householdPersonId: people[1].id, shareBps: 6000 }, { householdPersonId: people[2].id, shareBps: 4000 }], financing: { downPaymentCents: 0, installmentCount: 2, installmentAmountCents: 10_000, financingTotalCents: 20_000, firstInstallmentDate: '2026-09-17' } }, 1);
    await pay(purchase, 1, { actualAmountCents: 10_001 }, 1);
    const natalia = await dashboard('2026-09-17', 1);
    const other = await dashboard('2026-09-17', 2);
    expect(natalia.monthlyProgress.personal.budgetCents).toBe(6000);
    expect(other.monthlyProgress.personal.budgetCents).toBe(4000);
    expect(natalia.monthlyProgress.personal.usedCents + other.monthlyProgress.personal.usedCents).toBe(10_001);
    expect(natalia.monthlyProgress.common.usedCents).toBe(0);
    expect(natalia.budget.lines).toHaveLength(1);
    expect(JSON.stringify(natalia)).not.toContain('paymentAllocationSnapshot');
    expect(natalia.budget.lines[0]).toMatchObject({ scope: 'PERSONAL', personalPersonId: people[1].id, amountCents: 6000, shareBps: 6000 });
    expect((await calendar('2026-09-17', 2)).events[0].expectedAmountCents).toBe(4000);
    const owner = await dashboard();
    expect(owner.budget.lines).toHaveLength(0);
    expect((await calendar()).events).toHaveLength(0);
  }));

  it('freezes paid ownership while future obligations change; old viewer gets generic history without current detail access', async () => fixture(async (_tx, { app, base, userIds, create, pay, patch, dashboard, calendar, people }) => {
    const purchase = await create({ ownershipType: 'PERSONAL', personalPersonId: people[0].id, financing: { ...septemberFinancing, downPaymentCents: 0, installmentAmountCents: 6000, financingTotalCents: 120_000 } });
    await pay(purchase);
    await patch(purchase, { ownershipType: 'PERSONAL', personalPersonId: people[1].id });
    await auth(request(app).get(`${base}/${purchase.id}`), userIds[0]).expect(404);
    expect((await dashboard()).monthlyProgress.personal).toMatchObject({ budgetCents: 6000, usedCents: 6000 });
    expect((await dashboard('2026-10-17')).monthlyProgress.personal.budgetCents).toBe(0);
    expect((await dashboard('2026-10-17', 1)).monthlyProgress.personal.budgetCents).toBe(6000);
    const history = (await calendar()).events[0];
    expect(history).toMatchObject({ name: 'Pago histórico de compra · Cuota 1/20', canAccessPurchase: false, canEditPayment: false });
    expect((await dashboard('2026-09-17', 1)).monthlyProgress.personal.usedCents).toBe(0);
  }));

  it('archiving keeps real history and hides all unpaid obligations', async () => fixture(async (_tx, { app, base, userIds, create, pay, dashboard, calendar }) => {
    const purchase = await create({ financing: { ...septemberFinancing, downPaymentPaidAt: '2026-09-17' } });
    await pay(purchase);
    await write(request(app).delete(`${base}/${purchase.id}`), userIds[0]).expect(200);
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 25_000, usedCents: 25_000 });
    expect((await dashboard('2026-10-17')).monthlyProgress.common.budgetCents).toBe(0);
    expect((await calendar()).events.every((event) => event.status === 'PAID' && !event.canAccessPurchase)).toBe(true);
  }));

  it('recalculates unpaid financing once and simulation/planning use the same budget without rewriting prepared data', async () => fixture(async (tx, { app, prefix, userIds, people, create, patch, read, dashboard }) => {
    await write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send({ calculationDate: '2026-09-17', confirmedBalanceCents: 10_000, confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 1000 })) }).expect(201);
    const before = (await dashboard()).planning;
    const stored = await tx.monthlyPlanning.findUnique({ where: { id: before.id }, include: { contributions: true } });
    const purchase = await create({ financing: septemberFinancing });
    const first = await dashboard();
    expect(first.planning).toMatchObject({ budgetChangedSincePreparation: true, preparedHouseholdBudgetCents: 0, householdBudgetCents: 0, budgetComparison: { householdDifferenceCents: 25_000 } });
    const balancesByPerson = (planning) => Object.fromEntries(planning.contributions.map((row) => [row.householdPersonId, row.confirmedPersonalBalanceCents]));
    expect(balancesByPerson(first.planning)).toEqual(balancesByPerson(before));
    expect((await read('/simulation?date=2026-09-17')).monthlyStandardBudgetCents).toBe(25_000);
    await patch(purchase, { financing: { installmentCount: 10, installmentAmountCents: 10_000 } });
    expect((await dashboard()).monthlyProgress.common.budgetCents).toBe(30_000);
    expect(await tx.monthlyPlanning.findUnique({ where: { id: before.id }, include: { contributions: true } })).toEqual(stored);
  }));

  it('historical personal allocation survives archived/relinked profiles without leaking it to the new linked actor', async () => fixture(async (tx, { household, people, userIds, upfront, dashboard }) => {
    await upfront({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    await tx.householdPerson.update({ where: { id: people[0].id }, data: { linkedUserId: null, isActive: false, archivedAt: new Date(), contributionBps: 0 } });
    await tx.householdPerson.update({ where: { id: people[1].id }, data: { contributionBps: 10_000 } });
    const withoutProfile = await dashboard();
    expect(withoutProfile.budget.readiness.ready).toBe(true);
    expect(withoutProfile.budget.contributions).toHaveLength(2);
    expect(withoutProfile.monthlyProgress.personal).toMatchObject({ personName: 'Tú', budgetCents: 90_000, usedCents: 90_000 });
    expect(withoutProfile.budget.lines[0].personalPersonId).toBeNull();
    const replacement = await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userIds[0], name: 'Nuevo perfil', contributionBps: 0 } });
    expect((await dashboard()).monthlyProgress.personal).toMatchObject({ personId: replacement.id, budgetCents: 90_000, usedCents: 90_000 });
    await tx.householdPerson.update({ where: { id: people[2].id }, data: { linkedUserId: null } });
    await tx.householdPerson.update({ where: { id: people[0].id }, data: { linkedUserId: userIds[2] } });
    const other = await dashboard('2026-09-17', 2);
    expect(other.budget.personalBudgetCents).toBe(0);
    expect(other.budget.lines).toHaveLength(0);
  }));

  it('paid corrections move cash month explicitly and reverting removes used while preserving expected budget', async () => fixture(async (_tx, { app, base, userIds, create, pay, dashboard }) => {
    const purchase = await create({ financing: septemberFinancing });
    await pay(purchase, 1, { actualAmountCents: 5200 });
    const endpoint = `${base}/${purchase.id}/installments/${purchase.financing.installments[0].id}/payment`;
    await write(request(app).patch(endpoint), userIds[0]).send({ actualAmountCents: 5300, paidAt: '2026-08-31' }).expect(200);
    expect((await dashboard('2026-08-31')).monthlyProgress.common).toMatchObject({ budgetCents: 0, usedCents: 5300 });
    expect((await dashboard()).monthlyProgress.common).toMatchObject({ budgetCents: 25_000, usedCents: 0 });
    await write(request(app).delete(endpoint), userIds[0]).send({ confirm: true }).expect(200);
    expect((await dashboard('2026-08-31')).monthlyProgress.common.usedCents).toBe(0);
    expect((await dashboard()).monthlyProgress.common.budgetCents).toBe(25_000);
  }));

  it('stored Planning identity prevents relinking from disclosing former user amounts or balances, including GET history', async () => fixture(async (tx, { app, prefix, userIds, people, upfront, dashboard, read }) => {
    await upfront({ ownershipType: 'PERSONAL', personalPersonId: people[0].id });
    const prepared = (await write(request(app).post(`${prefix}/plannings/prepare`), userIds[0]).send({ calculationDate: '2026-09-17', confirmedBalanceCents: 10_000, confirmedPersonalBalances: people.map((person, index) => ({ personId: person.id, balanceCents: index === 0 ? 876_543 : 0 })) }).expect(201)).body.data;
    const saved = await tx.monthlyPlanning.findUnique({ where: { id: prepared.id }, include: { contributions: true } });
    expect(saved.breakdown.personIdentitySnapshot).toContainEqual({ personId: people[0].id, linkedUserId: userIds[0] });
    await tx.householdPerson.update({ where: { id: people[2].id }, data: { linkedUserId: null } });
    await tx.householdPerson.update({ where: { id: people[0].id }, data: { linkedUserId: userIds[2] } });
    const history = await read('/plannings?year=2026&month=9', 2);
    expect(JSON.stringify(history)).not.toContain('876543');
    expect(history[0].recommendedBudgetCents).toBe(0);
    expect(history[0].contributions.every((row) => row.personalExpenseCents === 0)).toBe(true);
    const newActor = await dashboard('2026-09-17', 2);
    expect(JSON.stringify(newActor)).not.toContain('876543');
    expect(newActor.monthlyProgress.personal).toMatchObject({ budgetCents: 0, usedCents: 0 });
    expect(newActor.cashCoverage.personal).toBeNull();
    expect(newActor.accountSummary.personal[0].balanceCents).toBe(0);
    const original = (await read('/plannings?year=2026&month=9'))[0];
    expect(original.contributions.find((row) => row.householdPersonId === people[0].id).confirmedPersonalBalanceCents).toBe(876_543);
    expect(await tx.monthlyPlanning.findUnique({ where: { id: prepared.id }, include: { contributions: true } })).toEqual(saved);
  }));
});
