import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';

// Explicit opt-in, local database only. Each fixture and every successful HTTP
// mutation live in one transaction that is rolled back, including on failure.
const enabled = process.env.MONTHLY_PROGRESS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_MONTHLY_PROGRESS_TEST');
const day = (value) => new Date(`${value}T00:00:00.000Z`);

function appFor(prisma, userId) {
  const app = express();
  app.use(express.json());
  app.use('/api', createFinanceRouter({
    prisma,
    authenticate: (req, _res, next) => { req.auth = { userId }; next(); },
    requireCsrf: (_req, _res, next) => next(),
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? (error.issues ? 400 : 500))
    .json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message, details: error.issues }));
  return app;
}

async function withFixture(operation) {
  const hostname = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Las pruebas del progreso mensual solo admiten una base de datos local.');
  }
  const userIds = [crypto.randomUUID(), crypto.randomUUID()];
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Monthly progress test', email: `${id}@monthly-progress.invalid` })) });
      const household = await tx.household.create({ data: {
        name: 'Monthly progress test', ownerUserId: userIds[0], safetyMarginBps: 0, currentBalanceCents: 145_000,
      } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: {
          householdId: household.id, linkedUserId: userId, name: `Persona ${index}`, contributionBps: 5000,
        } }));
      }
      const category = await tx.category.create({ data: {
        householdId: household.id, name: 'Mensual', slug: 'monthly', icon: 'Zap', color: '#000000',
      } });
      const expenseData = {
        householdId: household.id, categoryId: category.id, name: 'Recurrente común',
        scope: 'HOUSEHOLD', amountCents: 120_000, frequency: 'MONTHLY',
        startDate: day('2026-01-01'), nextDueDate: day('2026-09-30'), usualDayOfMonth: 30,
      };
      const expense = await tx.recurringExpense.create({ data: expenseData });
      const adapter = new Proxy(tx, { get: (target, property) => property === '$transaction'
        ? (callback) => callback(adapter) : Reflect.get(target, property) });
      const apps = userIds.map((userId) => appFor(adapter, userId));
      const base = `/api/households/${household.id}`;
      const read = async (date = '2026-09-17', app = apps[0]) =>
        (await request(app).get(`${base}/dashboard`).query({ date }).expect(200)).body.data;
      await operation(tx, { household, people, category, expense, expenseData, userIds, apps, base, read });
      throw rollback;
    }, { timeout: 25_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('monthly progress API with PostgreSQL', () => {
  it('registering, correcting and skipping a historical payment updates the original dueDate month', async () => {
    await withFixture(async (_tx, fixture) => {
      const { apps, base, expense, read } = fixture;
      expect((await read()).monthlyProgress.common.usedCents).toBe(0);
      const path = `${base}/recurring-expenses/${expense.id}/payments`;
      const { body } = await request(apps[0]).post(path).send({
        dueDate: '2026-09-30', status: 'PAID', actualAmountCents: 58_000, paymentDate: '2026-10-02',
      }).expect(201);
      expect((await read()).monthlyProgress.common).toMatchObject({ budgetCents: 120_000, usedCents: 58_000, remainingCents: 62_000, progressBps: 4833 });
      expect((await read()).cashCoverage.common).toMatchObject({ balanceCents: 145_000, remainingBudgetCents: 62_000, cushionCents: 83_000, status: 'COVERED' });
      expect((await read('2026-10-02')).monthlyProgress.common.usedCents).toBe(0);
      await request(apps[0]).patch(`${path}/${body.data.payment.id}`).send({
        status: 'PAID', actualAmountCents: 60_000, paymentDate: '2026-10-03',
      }).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(60_000);
      await request(apps[0]).patch(`${path}/${body.data.payment.id}`).send({
        status: 'SKIPPED', actualAmountCents: null, paymentDate: null,
      }).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(0);
    });
  });

  it.each([0, 1])('protects all personal scopes and balances for authenticated viewer %i, including OWNER', async (viewer) => {
    await withFixture(async (tx, fixture) => {
      const { people, expenseData, category, household, userIds, apps, read } = fixture;
      const personalExpenses = [];
      for (const [index, person] of people.entries()) {
        const privateAmount = index === viewer ? 10_000 : 765_432;
        personalExpenses.push(await tx.recurringExpense.create({ data: {
          ...expenseData, name: index === viewer ? 'Propio' : 'SECRETO_NO_VISIBLE', scope: 'PERSONAL', personalPersonId: person.id, amountCents: privateAmount,
        } }));
        await tx.expensePayment.create({ data: {
          recurringExpenseId: personalExpenses[index].id, recordedByUserId: userIds[index],
          dueDate: day('2026-09-30'), status: 'PAID', actualAmountCents: privateAmount,
          expectedAmountCents: privateAmount, paymentDate: day('2026-09-17'),
        } });
        await tx.variableExpenseMonth.create({ data: {
          householdId: household.id, categoryId: category.id, scope: 'PERSONAL', personalPersonId: person.id,
          ownerKey: person.id, year: 2026, month: 9, entryMode: 'SUMMARY', summaryAmountCents: privateAmount,
        } });
        await tx.utilityInvoice.create({ data: {
          householdId: household.id, categoryId: category.id, scope: 'PERSONAL', personalPersonId: person.id,
          amountCents: privateAmount, periodStart: day('2026-08-01'), periodEnd: day('2026-08-31'),
          invoiceDate: day('2026-09-01'), chargeDate: day('2026-09-17'),
        } });
        await tx.householdAccount.create({ data: {
          householdId: household.id, scope: 'PERSONAL', personalPersonId: person.id,
          name: index === viewer ? 'Cuenta propia' : 'SECRETO_NO_VISIBLE', balanceCents: privateAmount,
        } });
      }
      const result = await read('2026-09-17', apps[viewer]);
      expect(result.monthlyProgress.common.usedCents).toBe(0);
      expect(result.monthlyProgress.personal).toMatchObject({ personId: people[viewer].id, usedCents: 30_000 });
      expect(result.cashCoverage.personal).toMatchObject({ personId: people[viewer].id, balanceCents: 10_000 });
      expect(JSON.stringify(result)).not.toContain('765432');
      expect(JSON.stringify(result)).not.toContain('SECRETO_NO_VISIBLE');
      expect(result.budget.lines.every((line) => line.scope === 'HOUSEHOLD' || line.personalPersonId === people[viewer].id)).toBe(true);
    });
  });

  it('after preparation uses dynamic one-off budgets and newly edited balances, without changing prepared contributions', async () => {
    await withFixture(async (tx, fixture) => {
      const { apps, base, people, household, category, read } = fixture;
      await request(apps[0]).post(`${base}/plannings/prepare`).send({
        calculationDate: '2026-09-17', confirmedBalanceCents: 150_000,
        confirmedPersonalBalances: people.map((person) => ({ personId: person.id, balanceCents: 25_000 })),
      }).expect(201);
      const before = await read();
      const storedBefore = await tx.monthlyPlanning.findUnique({ where: { id: before.planning.id }, include: { contributions: true } });
      expect(before.planning).not.toBeNull();
      expect(before.monthlyProgress.common.budgetCents).toBe(120_000);
      const oneOff = await tx.oneTimeExpense.create({ data: {
        householdId: household.id, categoryId: category.id, name: 'Decisión sin transacción', amountCents: 15_000, expenseDate: day('2026-09-20'),
      } });
      const withOneOff = await read();
      expect(withOneOff.monthlyProgress.common).toMatchObject({ budgetCents: 135_000, usedCents: 0, remainingCents: 135_000 });
      expect(withOneOff.planning).toMatchObject({ budgetChangedSincePreparation: true, preparedHouseholdBudgetCents: 120_000, householdBudgetCents: 120_000, budgetComparison: { householdDifferenceCents: 15_000 } });
      expect(withOneOff.planning.contributions.map((row) => row.confirmedPersonalBalanceCents))
        .toEqual(before.planning.contributions.map((row) => row.confirmedPersonalBalanceCents));
      expect(await tx.monthlyPlanning.findUnique({ where: { id: before.planning.id }, include: { contributions: true } })).toEqual(storedBefore);
      await tx.oneTimeExpense.update({ where: { id: oneOff.id }, data: { amountCents: 20_000 } });
      expect((await read()).monthlyProgress.common.budgetCents).toBe(140_000);
      await request(apps[0]).patch(`${base}/balance`).send({ balanceCents: 180_000 }).expect(200);
      expect((await read()).cashCoverage.common).toMatchObject({ balanceCents: 180_000, balanceSource: 'HOUSEHOLD' });
      const account = await tx.householdAccount.create({ data: { householdId: household.id, name: 'Cuenta', balanceCents: 190_000 } });
      expect((await read()).cashCoverage.common).toMatchObject({ balanceCents: 190_000, balanceSource: 'ACCOUNTS' });
      await request(apps[0]).patch(`${base}/accounts/${account.id}`).send({ balanceCents: 40_000 }).expect(200);
      expect((await read()).cashCoverage.common).toMatchObject({ balanceCents: 40_000, shortfallCents: 100_000, status: 'SHORTFALL' });
    });
  });

  it('variable detail and summary edits are reflected; invoice chargeDate takes priority over invoiceDate', async () => {
    await withFixture(async (_tx, fixture) => {
      const { apps, base, category, read } = fixture;
      const variable = { categoryId: category.id, scope: 'HOUSEHOLD', year: 2026, month: 9 };
      await request(apps[0]).put(`${base}/variable-expenses/month`).send({
        ...variable, entryMode: 'DETAIL', entries: [{ spentOn: '2026-09-10', amountCents: 7000 }, { spentOn: '2026-09-12', amountCents: 11_000 }],
      }).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(18_000);
      await request(apps[0]).put(`${base}/variable-expenses/month`).send({
        ...variable, entryMode: 'SUMMARY', summaryAmountCents: 25_000,
      }).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(25_000);
      const { body } = await request(apps[0]).post(`${base}/invoices`).send({
        categoryId: category.id, scope: 'HOUSEHOLD', amountCents: 8500,
        periodStart: '2026-08-01', periodEnd: '2026-08-31', invoiceDate: '2026-09-01', chargeDate: '2026-10-03',
      }).expect(201);
      expect((await read()).monthlyProgress.common.usedCents).toBe(25_000);
      expect((await read('2026-10-03')).monthlyProgress.common.usedCents).toBe(8500);
      await request(apps[0]).patch(`${base}/invoices/${body.data.id}`).send({ chargeDate: null }).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(33_500);
      expect((await read('2026-10-03')).monthlyProgress.common.usedCents).toBe(0);
      await request(apps[0]).delete(`${base}/invoices/${body.data.id}`).expect(200);
      expect((await read()).monthlyProgress.common.usedCents).toBe(25_000);
    });
  });

  it('keeps December and January separate across the year boundary, including archived paid parents', async () => {
    await withFixture(async (tx, fixture) => {
      const { expense, userIds, read } = fixture;
      await tx.expensePayment.createMany({ data: [
        { recurringExpenseId: expense.id, recordedByUserId: userIds[0], dueDate: day('2026-12-31'), expectedAmountCents: 1599,
          actualAmountCents: 1599, status: 'PAID', paymentDate: day('2027-01-02') },
        { recurringExpenseId: expense.id, recordedByUserId: userIds[0], dueDate: day('2027-01-01'), expectedAmountCents: 2999,
          actualAmountCents: 2999, status: 'PAID', paymentDate: day('2026-12-31') },
      ] });
      await tx.recurringExpense.update({ where: { id: expense.id }, data: { isActive: false, archivedAt: new Date() } });
      expect((await read('2026-12-31')).monthlyProgress.common).toMatchObject({ budgetCents: 0, usedCents: 1599, remainingCents: 0, overBudgetCents: 1599 });
      expect((await read('2027-01-01')).monthlyProgress.common.usedCents).toBe(2999);
      expect((await read('2027-02-01')).monthlyProgress.common.usedCents).toBe(0);
    });
  });
});
