import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { calculateHouseholdBudget } from '../src/modules/finance/finance.service.js';
import { createRecurringExpenseSchema } from '../src/modules/finance/finance.schemas.js';
import { calculateNextDueDate } from '../src/services/recurrence.service.js';

// Opt-in, local PostgreSQL only. All synthetic fixtures are rolled back on success and failure.
const enabled = process.env.CUSTOM_WEEKS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_CUSTOM_WEEKS_TEST');

async function withFixture(operation) {
  const hostname = new URL(process.env.DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('Las pruebas de migración solo admiten una base de datos local.');
  }

  const userId = crypto.randomUUID();
  try {
    await database.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: userId, name: 'Weeks test', email: `${userId}@weeks-test.invalid` },
      });
      const household = await tx.household.create({
        data: { name: 'Weeks test', ownerUserId: userId, safetyMarginBps: 1000 },
      });
      const category = await tx.category.create({
        data: { householdId: household.id, name: 'Weeks test', slug: 'weeks-test', icon: 'Zap', color: '#000000' },
      });
      await tx.householdPerson.create({
        data: { householdId: household.id, linkedUserId: userId, name: 'Weeks test', contributionBps: 10_000 },
      });
      const expenseData = {
        householdId: household.id,
        categoryId: category.id,
        name: 'Gimnasio de prueba',
        amountCents: 4000,
        frequency: 'CUSTOM_WEEKS',
        intervalWeeks: 4,
        startDate: new Date('2026-09-17T00:00:00.000Z'),
        nextDueDate: new Date('2026-09-17T00:00:00.000Z'),
      };
      await operation(tx, { householdId: household.id, userId, expenseData });
      throw rollback;
    }, { timeout: 15_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(await database.user.findUnique({ where: { id: userId } })).toBeNull();
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('semanas reales en PostgreSQL (rollback)', () => {
  it('mantiene intervalWeeks nullable y no modifica los gastos de frecuencias anteriores', async () => {
    await withFixture(async (tx, { expenseData }) => {
      const column = await tx.$queryRaw`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'RecurringExpense' AND column_name = 'intervalWeeks'
      `;
      expect(column).toEqual([{ is_nullable: 'YES', column_default: null }]);

      const existingExpenseData = { ...expenseData };
      delete existingExpenseData.intervalWeeks;
      const existing = [];
      for (const frequency of ['WEEKLY', 'MONTHLY', 'CUSTOM_MONTHS']) {
        const expense = await tx.recurringExpense.create({
          data: {
            ...existingExpenseData,
            frequency,
            intervalMonths: frequency === 'CUSTOM_MONTHS' ? 3 : null,
          },
        });
        expect(expense.intervalWeeks).toBeNull();
        existing.push(expense);
      }

      const created = await tx.recurringExpense.create({ data: expenseData });
      expect(created).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks: 4, intervalMonths: null });
      for (const expense of existing) {
        expect(await tx.recurringExpense.findUnique({ where: { id: expense.id } })).toEqual(expense);
      }
    });
  });

  it('carga el intervalo persistido y calcula 43,33 € de base y 47,66 € con margen', async () => {
    await withFixture(async (tx, { householdId, userId, expenseData }) => {
      const created = await tx.recurringExpense.create({ data: expenseData });
      const expense = await tx.recurringExpense.findUnique({ where: { id: created.id } });
      const nextDueDate = calculateNextDueDate(
        expense.nextDueDate,
        expense.frequency,
        expense.intervalMonths,
        expense.usualDayOfMonth,
        expense.intervalWeeks,
      );
      expect(nextDueDate.toISOString()).toBe('2026-10-15T00:00:00.000Z');
      const { budget } = await calculateHouseholdBudget(tx, householdId, '2026-09-17', userId);
      expect(budget.lines).toHaveLength(1);
      expect(budget.lines[0]).toMatchObject({
        id: expense.id,
        baseCents: 4333,
        effectiveMarginBps: 1000,
        amountCents: 4766,
      });
    });
  });

  it.each([2, 520])('permite el límite válido de %s semanas en PostgreSQL', async (intervalWeeks) => {
    await withFixture(async (tx, { expenseData }) => {
      const created = await tx.recurringExpense.create({ data: { ...expenseData, intervalWeeks } });
      expect(created).toMatchObject({ frequency: 'CUSTOM_WEEKS', intervalWeeks, intervalMonths: null });
    });
  });

  it.each([null, 1, 521])('rechaza intervalWeeks=%s fuera de la API mediante la restricción de base de datos', async (intervalWeeks) => {
    await withFixture(async (tx, { expenseData }) => {
      await expect(tx.recurringExpense.create({ data: { ...expenseData, intervalWeeks } }))
        .rejects.toThrow(/check constraint|RecurringExpense_.*interval/i);
    });
  });

  it('rechaza semanas decimales en backend antes de persistirlas con Prisma', async () => {
    await withFixture(async (tx, { householdId, expenseData }) => {
      const body = { ...expenseData };
      delete body.householdId;
      // Prisma Int can truncate a JavaScript float; the API must validate before persistence.
      const parsed = createRecurringExpenseSchema.safeParse({
        ...body,
        intervalWeeks: 2.5,
        startDate: '2026-09-17',
        nextDueDate: '2026-09-17',
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ['intervalWeeks'] }));
      expect(await tx.recurringExpense.count({ where: { householdId } })).toBe(0);
    });
  });

  it('impide guardar intervalWeeks en un gasto mensual incluso fuera de la API', async () => {
    await withFixture(async (tx, { expenseData }) => {
      await expect(tx.recurringExpense.create({ data: { ...expenseData, frequency: 'MONTHLY' } }))
        .rejects.toThrow(/check constraint|RecurringExpense_.*interval/i);
    });
  });
});
