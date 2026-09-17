import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { calculateHouseholdBudget } from '../src/modules/finance/finance.service.js';

// Opt-in, local PostgreSQL only. All fixtures are rolled back, including failures.
const enabled = process.env.BUDGET_MARGIN_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_BUDGET_MARGIN_TEST');

async function withFixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) {
    throw new Error('Las pruebas de migración solo admiten una base de datos local.');
  }
  const userId = crypto.randomUUID();
  try {
    await database.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, name: 'Margin test', email: `${userId}@margin-test.invalid` } });
      const household = await tx.household.create({ data: { name: 'Margin test', ownerUserId: userId, safetyMarginBps: 1000 } });
      const category = await tx.category.create({ data: { householdId: household.id, name: 'Margin test', slug: 'margin-test', icon: 'Zap', color: '#000000' } });
      const person = await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: 'Margin test', contributionBps: 10_000 } });
      await operation(tx, { householdId: household.id, categoryId: category.id, userId, personId: person.id });
      throw rollback;
    }, { timeout: 15_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(await database.user.findUnique({ where: { id: userId } })).toBeNull();
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('migración de márgenes en PostgreSQL real (rollback)', () => {
  it('valida defaults y carga financiera real sin modificar facturas ni meses', async () => {
    await withFixture(async (tx, { householdId, categoryId, userId }) => {
      const invoice = await tx.utilityInvoice.create({ data: { householdId, categoryId, amountCents: 10_000, periodStart: new Date('2026-08-01'), periodEnd: new Date('2026-08-31'), invoiceDate: new Date('2026-09-01') } });
      const month = await tx.variableExpenseMonth.create({ data: { householdId, categoryId, ownerKey: 'HOUSEHOLD', year: 2026, month: 8, entryMode: 'SUMMARY', summaryAmountCents: 10_000 } });
      const punctual = await tx.oneTimeExpense.create({ data: { householdId, categoryId, name: 'Margin test', amountCents: 10_000, expenseDate: new Date('2026-09-17') } });
      expect(punctual.applySafetyMargin).toBe(false);
      const before = (await calculateHouseholdBudget(tx, householdId, '2026-09-17', userId)).budget;
      expect(before.lines).toHaveLength(3);
      expect(before.lines.every((line) => line.effectiveMarginBps === 0 && line.amountCents === line.baseCents)).toBe(true);
      for (const expenseType of ['INVOICE', 'VARIABLE']) {
        const preference = await tx.budgetMarginPreference.create({ data: { householdId, categoryId, ownerKey: 'HOUSEHOLD', expenseType } });
        expect(preference.applySafetyMargin).toBe(false);
        await tx.budgetMarginPreference.update({ where: { id: preference.id }, data: { applySafetyMargin: true } });
      }
      await tx.oneTimeExpense.update({ where: { id: punctual.id }, data: { applySafetyMargin: true } });
      for (const expectedMargin of [1000, 1500, 0]) {
        if (expectedMargin !== 1000) await tx.category.update({ where: { id: categoryId }, data: { safetyMarginBps: expectedMargin } });
        const after = (await calculateHouseholdBudget(tx, householdId, '2026-09-17', userId)).budget;
        after.lines.forEach((line, index) => {
          expect(line.baseCents).toBe(before.lines[index].baseCents);
          expect(line.effectiveMarginBps).toBe(expectedMargin);
          expect(line.amountCents).toBe(Math.round(line.baseCents * (10_000 + expectedMargin) / 10_000));
        });
      }
      expect(await tx.utilityInvoice.findUnique({ where: { id: invoice.id } })).toEqual(invoice);
      expect(await tx.variableExpenseMonth.findUnique({ where: { id: month.id } })).toEqual(month);
    });
  });

  it('el índice UNIQUE impide duplicar el grupo común aunque personalPersonId sea NULL', async () => {
    await withFixture(async (tx, { householdId, categoryId }) => {
      const data = { householdId, categoryId, ownerKey: 'HOUSEHOLD', expenseType: 'INVOICE' };
      await tx.budgetMarginPreference.create({ data });
      await expect(tx.budgetMarginPreference.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  it('el CHECK impide un propietario incoherente incluso fuera de la API', async () => {
    await withFixture(async (tx, { householdId, categoryId, personId }) => {
      await expect(tx.budgetMarginPreference.create({ data: { householdId, categoryId, ownerKey: 'HOUSEHOLD', expenseType: 'VARIABLE', scope: 'PERSONAL', personalPersonId: personId } })).rejects.toThrow(/BudgetMarginPreference_owner_check/);
    });
  });
});
