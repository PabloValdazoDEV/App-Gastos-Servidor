import express from 'express';

import { buildCalendar } from '../../services/calendar.service.js';
import { addCalendarMonths, toIsoDate } from '../../services/date.service.js';
import {
  calculateInvoiceStatistics,
  calculateVariableStatistics,
} from '../../services/budgetCalculator.service.js';
import {
  distributeTemporaryAdjustment,
  previewRecoveryPlan,
} from '../../services/planningCalculator.service.js';
import { calculateNextDueDate } from '../../services/recurrence.service.js';
import { sendSuccess } from '../../utils/httpResponses.js';
import {
  HOUSEHOLD_ROLES,
  requireHouseholdCategory,
  requireHouseholdPerson,
  requireHouseholdRole,
} from '../households/authorization.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  calculationQuerySchema,
  calendarQuerySchema,
  createInvoiceSchema,
  createRecurringExpenseSchema,
  editPaymentSchema,
  financeParamsSchema,
  invoiceQuerySchema,
  listRecurringQuerySchema,
  planningQuerySchema,
  prepareMonthSchema,
  recoveryPreviewSchema,
  registerPaymentSchema,
  updateBalanceSchema,
  updateInvoiceSchema,
  updateRecurringExpenseSchema,
  updateRecoverySchema,
  upsertVariableMonthSchema,
  variableQuerySchema,
} from './finance.schemas.js';
import {
  calculateDashboard,
  calculateHouseholdBudget,
  calculateHouseholdSimulation,
  dateOrToday,
  jsonValue,
  upcomingPayments,
} from './finance.service.js';
import {
  registerInvoiceDocumentRoutes,
} from './invoiceDocuments.js';

const memberAccess = (database, request) => {
  const { householdId } = financeParamsSchema.parse(request.params);
  return requireHouseholdRole(database, {
    householdId,
    userId: request.auth.userId,
    minimumRole: HOUSEHOLD_ROLES.MEMBER,
  });
};

const getRecurringExpense = async (database, householdId, expenseId) => {
  const expense = await database.recurringExpense.findFirst({
    where: { id: expenseId, householdId },
    include: { category: true, personalPerson: true, payments: { orderBy: { dueDate: 'desc' } } },
  });
  if (!expense) {
    throw createDomainError(
      404,
      'RECURRING_EXPENSE_NOT_FOUND',
      'No se encontró el gasto recurrente solicitado.',
    );
  }
  return expense;
};

const getInvoice = async (database, householdId, invoiceId) => {
  const invoice = await database.utilityInvoice.findFirst({
    where: { id: invoiceId, householdId },
    include: { category: true },
  });
  if (!invoice) {
    throw createDomainError(
      404,
      'INVOICE_NOT_FOUND',
      'No se encontró la factura solicitada.',
    );
  }
  return invoice;
};

const getVariableMonth = async (database, householdId, variableMonthId) => {
  const item = await database.variableExpenseMonth.findFirst({
    where: { id: variableMonthId, householdId },
    include: {
      category: true,
      personalPerson: true,
      entries: { orderBy: [{ spentOn: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!item) {
    throw createDomainError(
      404,
      'VARIABLE_MONTH_NOT_FOUND',
      'No se encontró el mes de gasto variable solicitado.',
    );
  }
  return item;
};

async function validateScope(database, householdId, scope, personalPersonId) {
  if (scope === 'PERSONAL') {
    if (!personalPersonId) {
      throw createDomainError(
        400,
        'PERSON_REQUIRED',
        'Selecciona la persona responsable del gasto personal.',
      );
    }
    await requireHouseholdPerson(database, {
      householdId,
      personId: personalPersonId,
    });
  } else if (personalPersonId) {
    throw createDomainError(
      400,
      'PERSON_NOT_ALLOWED',
      'Un gasto común no puede tener una persona asignada.',
    );
  }
}

function ownerKey(scope, personalPersonId) {
  return scope === 'PERSONAL' ? personalPersonId : 'HOUSEHOLD';
}

const monthBasedFrequency = (frequency) =>
  !['WEEKLY', 'ONE_TIME'].includes(frequency);

function normalizeNullableFields(body, fields) {
  return fields.reduce((result, field) => {
    if (Object.hasOwn(body, field)) result[field] = body[field] ?? null;
    return result;
  }, {});
}

export const createFinanceRouter = ({ prisma, authenticate, requireCsrf }) => {
  if (!prisma || !authenticate || !requireCsrf) {
    throw new TypeError('createFinanceRouter requiere prisma, authenticate y requireCsrf.');
  }

  const router = express.Router();
  router.use(
    [
      '/households/:householdId/recurring-expenses',
      '/households/:householdId/invoices',
      '/households/:householdId/variable-expenses',
      '/households/:householdId/balance',
      '/households/:householdId/budget',
      '/households/:householdId/dashboard',
      '/households/:householdId/calendar',
      '/households/:householdId/plannings',
      '/households/:householdId/simulation',
      '/households/:householdId/recovery-plans',
    ],
    authenticate,
  );

  router.get(
    '/households/:householdId/recurring-expenses',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = listRecurringQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const expenses = await prisma.recurringExpense.findMany({
        where: {
          householdId,
          ...(query.includeArchived ? {} : { archivedAt: null }),
          ...(query.scope ? { scope: query.scope } : {}),
        },
        include: {
          category: true,
          personalPerson: { select: { id: true, name: true } },
          payments: { orderBy: { dueDate: 'desc' }, take: 3 },
        },
        orderBy: [{ isActive: 'desc' }, { nextDueDate: 'asc' }, { name: 'asc' }],
      });
      return sendSuccess(response, expenses);
    }),
  );

  router.post(
    '/households/:householdId/recurring-expenses',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = createRecurringExpenseSchema.parse(request.body);
      await memberAccess(prisma, request);
      await requireHouseholdCategory(prisma, { householdId, categoryId: body.categoryId });
      await validateScope(prisma, householdId, body.scope, body.personalPersonId);

      const expense = await prisma.$transaction(async (database) => {
        const created = await database.recurringExpense.create({
          data: {
            householdId,
            categoryId: body.categoryId,
            personalPersonId: body.personalPersonId ?? null,
            name: body.name,
            amountCents: body.amountCents,
            scope: body.scope,
            frequency: body.frequency,
            intervalMonths: body.frequency === 'CUSTOM_MONTHS' ? body.intervalMonths : null,
            startDate: body.startDate,
            endDate: body.endDate ?? null,
            nextDueDate: body.nextDueDate,
            usualDayOfMonth:
              body.usualDayOfMonth ??
              (monthBasedFrequency(body.frequency)
                ? body.nextDueDate.getUTCDate()
                : null),
            safetyMarginOverrideBps: body.safetyMarginOverrideBps ?? null,
            remindersEnabled: body.remindersEnabled,
            notes: body.notes ?? null,
          },
          include: { category: true, personalPerson: true },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_CREATED',
          resourceType: 'RecurringExpense',
          resourceId: created.id,
        });
        return created;
      });
      return sendSuccess(response, expense, { statusCode: 201 });
    }),
  );

  router.get(
    '/households/:householdId/recurring-expenses/:expenseId',
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      return sendSuccess(response, await getRecurringExpense(prisma, householdId, expenseId));
    }),
  );

  router.patch(
    '/households/:householdId/recurring-expenses/:expenseId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = financeParamsSchema.parse(request.params);
      const body = updateRecurringExpenseSchema.parse(request.body);
      await memberAccess(prisma, request);
      const existing = await getRecurringExpense(prisma, householdId, expenseId);
      const scope = body.scope ?? existing.scope;
      const personalPersonId = Object.hasOwn(body, 'personalPersonId')
        ? body.personalPersonId
        : existing.personalPersonId;
      const categoryId = body.categoryId ?? existing.categoryId;
      await requireHouseholdCategory(prisma, { householdId, categoryId });
      await validateScope(prisma, householdId, scope, personalPersonId);
      const frequency = body.frequency ?? existing.frequency;
      const intervalMonths = Object.hasOwn(body, 'intervalMonths')
        ? body.intervalMonths
        : existing.intervalMonths;
      if (frequency === 'CUSTOM_MONTHS' && !intervalMonths) {
        throw createDomainError(
          400,
          'INTERVAL_MONTHS_REQUIRED',
          'Indica cada cuántos meses se repite el gasto.',
        );
      }

      const updated = await prisma.$transaction(async (database) => {
        const item = await database.recurringExpense.update({
          where: { id: expenseId },
          data: {
            ...body,
            personalPersonId: personalPersonId ?? null,
            intervalMonths: frequency === 'CUSTOM_MONTHS' ? intervalMonths : null,
            ...normalizeNullableFields(body, [
              'endDate',
              'usualDayOfMonth',
              'safetyMarginOverrideBps',
              'notes',
            ]),
          },
          include: { category: true, personalPerson: true },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_CHANGED',
          resourceType: 'RecurringExpense',
          resourceId: expenseId,
        });
        return item;
      });
      return sendSuccess(response, updated);
    }),
  );

  router.delete(
    '/households/:householdId/recurring-expenses/:expenseId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      await getRecurringExpense(prisma, householdId, expenseId);
      const archived = await prisma.$transaction(async (database) => {
        const item = await database.recurringExpense.update({
          where: { id: expenseId },
          data: { isActive: false, archivedAt: new Date() },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_DELETED',
          resourceType: 'RecurringExpense',
          resourceId: expenseId,
        });
        return item;
      });
      return sendSuccess(response, archived);
    }),
  );

  router.post(
    '/households/:householdId/recurring-expenses/:expenseId/payments',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = financeParamsSchema.parse(request.params);
      const body = registerPaymentSchema.parse(request.body);
      await memberAccess(prisma, request);
      const result = await runSerializableTransaction(prisma, async (database) => {
        const expense = await database.recurringExpense.findFirst({
          where: { id: expenseId, householdId, archivedAt: null },
        });
        if (!expense) {
          throw createDomainError(
            404,
            'RECURRING_EXPENSE_NOT_FOUND',
            'No se encontró el gasto recurrente solicitado.',
          );
        }
        const dueDate = body.dueDate ?? expense.nextDueDate;
        const expectedAmountCents = body.expectedAmountCents ?? expense.amountCents;
        const nextAmount =
          body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT'
            ? body.actualAmountCents
            : null;
        if (body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT' && nextAmount == null) {
          throw createDomainError(
            400,
            'NEXT_AMOUNT_REQUIRED',
            'Indica el importe esperado para el siguiente vencimiento.',
          );
        }
        let payment;
        try {
          payment = await database.expensePayment.create({
            data: {
              recurringExpenseId: expense.id,
              recordedByUserId: request.auth.userId,
              dueDate,
              expectedAmountCents,
              actualAmountCents: body.actualAmountCents ?? null,
              paymentDate: body.paymentDate ?? (body.status === 'PAID' ? dateOrToday() : null),
              status: body.status,
              nextAmountDecision: body.nextAmountDecision,
              nextExpectedAmountCents:
                body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT' ? nextAmount : null,
              notes: body.notes ?? null,
            },
          });
        } catch (error) {
          if (error?.code === 'P2002') {
            throw createDomainError(
              409,
              'PAYMENT_ALREADY_REGISTERED',
              'Ese vencimiento ya tiene un pago registrado.',
            );
          }
          throw error;
        }
        const isCurrentOccurrence =
          toIsoDate(dueDate) === toIsoDate(expense.nextDueDate);
        const nextDueDate = isCurrentOccurrence
          ? calculateNextDueDate(
              dueDate,
              expense.frequency,
              expense.intervalMonths,
              expense.usualDayOfMonth ??
                (monthBasedFrequency(expense.frequency)
                  ? (expense.startDate ?? expense.nextDueDate).getUTCDate()
                  : null),
            )
          : expense.nextDueDate;
        const updatedExpense = isCurrentOccurrence
          ? await database.recurringExpense.update({
              where: { id: expense.id },
              data: {
                ...(nextDueDate
                  ? { nextDueDate }
                  : { isActive: false, archivedAt: new Date() }),
                ...(body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT'
                  ? { amountCents: nextAmount }
                  : {}),
              },
            })
          : expense;
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'PAYMENT_REGISTERED',
          resourceType: 'ExpensePayment',
          resourceId: payment.id,
          metadata: {
            recurringExpenseId: expense.id,
            previousAmountCents: expense.amountCents,
            nextAmountCents: updatedExpense.amountCents,
          },
        });
        return { payment, recurringExpense: updatedExpense };
      });
      return sendSuccess(response, result, { statusCode: 201 });
    }),
  );

  router.get(
    '/households/:householdId/recurring-expenses/:expenseId/payments',
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      await getRecurringExpense(prisma, householdId, expenseId);
      const payments = await prisma.expensePayment.findMany({
        where: { recurringExpenseId: expenseId },
        orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
      });
      return sendSuccess(response, payments);
    }),
  );

  router.patch(
    '/households/:householdId/recurring-expenses/:expenseId/payments/:paymentId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, expenseId, paymentId } = financeParamsSchema.parse(request.params);
      const body = editPaymentSchema.parse(request.body);
      await memberAccess(prisma, request);
      await getRecurringExpense(prisma, householdId, expenseId);

      const payment = await prisma.$transaction(async (database) => {
        const existing = await database.expensePayment.findFirst({
          where: { id: paymentId, recurringExpenseId: expenseId },
        });
        if (!existing) {
          throw createDomainError(
            404,
            'PAYMENT_NOT_FOUND',
            'No se encontró el pago solicitado.',
          );
        }

        const updated = await database.expensePayment.update({
          where: { id: paymentId },
          data: {
            status: body.status,
            actualAmountCents: body.status === 'PAID' ? body.actualAmountCents : null,
            paymentDate: body.status === 'PAID' ? body.paymentDate : null,
            ...(Object.hasOwn(body, 'notes') ? { notes: body.notes ?? null } : {}),
          },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_CHANGED',
          resourceType: 'ExpensePayment',
          resourceId: paymentId,
          metadata: {
            recurringExpenseId: expenseId,
            previousStatus: existing.status,
            status: updated.status,
            historicalPaymentCorrection: true,
          },
        });
        return updated;
      });
      return sendSuccess(response, payment);
    }),
  );

  router.get(
    '/households/:householdId/invoices',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = invoiceQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const invoices = await prisma.utilityInvoice.findMany({
        where: { householdId, ...(query.categoryId ? { categoryId: query.categoryId } : {}) },
        include: {
          category: true,
          _count: { select: { documents: true } },
        },
        orderBy: [{ periodEnd: 'desc' }, { invoiceDate: 'desc' }],
      });
      return sendSuccess(
        response,
        invoices.map(({ _count, ...invoice }) => ({
          ...invoice,
          documentCount: _count.documents,
        })),
      );
    }),
  );

  router.post(
    '/households/:householdId/invoices',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = createInvoiceSchema.parse(request.body);
      await memberAccess(prisma, request);
      await requireHouseholdCategory(prisma, { householdId, categoryId: body.categoryId });
      const invoice = await prisma.$transaction(async (database) => {
        const item = await database.utilityInvoice.create({
          data: { householdId, ...body, chargeDate: body.chargeDate ?? null, notes: body.notes ?? null },
          include: { category: true },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_CREATED',
          resourceType: 'UtilityInvoice',
          resourceId: item.id,
        });
        return item;
      });
      return sendSuccess(response, invoice, { statusCode: 201 });
    }),
  );

  router.get(
    '/households/:householdId/invoices/statistics',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = invoiceQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const household = await prisma.household.findUnique({ where: { id: householdId } });
      const invoices = await prisma.utilityInvoice.findMany({
        where: { householdId, ...(query.categoryId ? { categoryId: query.categoryId } : {}) },
        include: { category: true },
        orderBy: { periodEnd: 'asc' },
      });
      const groups = new Map();
      invoices.forEach((invoice) => {
        const current = groups.get(invoice.categoryId) ?? [];
        current.push(invoice);
        groups.set(invoice.categoryId, current);
      });
      const statistics = [...groups.entries()].map(([categoryId, items]) => ({
        categoryId,
        category: items[0].category,
        ...calculateInvoiceStatistics(items, {
          householdMarginBps: household.safetyMarginBps,
          categoryMarginBps: items[0].category.safetyMarginBps,
        }),
      }));
      return sendSuccess(response, statistics);
    }),
  );

  router.patch(
    '/households/:householdId/invoices/:invoiceId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, invoiceId } = financeParamsSchema.parse(request.params);
      const body = updateInvoiceSchema.parse(request.body);
      await memberAccess(prisma, request);
      const existing = await getInvoice(prisma, householdId, invoiceId);
      if (body.categoryId) {
        await requireHouseholdCategory(prisma, { householdId, categoryId: body.categoryId });
      }
      const start = toIsoDate(body.periodStart ?? existing.periodStart);
      const end = toIsoDate(body.periodEnd ?? existing.periodEnd);
      if (end < start) {
        throw createDomainError(
          400,
          'INVALID_INVOICE_PERIOD',
          'El fin del periodo no puede ser anterior al inicio.',
        );
      }
      const invoice = await prisma.$transaction(async (database) => {
        const item = await database.utilityInvoice.update({
          where: { id: invoiceId },
          data: { ...body, ...normalizeNullableFields(body, ['chargeDate', 'notes']) },
          include: { category: true },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'EXPENSE_CHANGED',
          resourceType: 'UtilityInvoice',
          resourceId: invoiceId,
        });
        return item;
      });
      return sendSuccess(response, invoice);
    }),
  );

  router.delete(
    '/households/:householdId/invoices/:invoiceId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, invoiceId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      await getInvoice(prisma, householdId, invoiceId);
      await prisma.utilityInvoice.delete({ where: { id: invoiceId } });
      return sendSuccess(response, { id: invoiceId, deleted: true });
    }),
  );

  registerInvoiceDocumentRoutes({
    router,
    prisma,
    requireCsrf,
    memberAccess,
    getInvoice,
  });

  router.get(
    '/households/:householdId/variable-expenses',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = variableQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const months = await prisma.variableExpenseMonth.findMany({
        where: {
          householdId,
          ...(query.year ? { year: query.year } : {}),
          ...(query.month ? { month: query.month } : {}),
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(query.ownerKey ? { ownerKey: query.ownerKey } : {}),
        },
        include: {
          category: true,
          personalPerson: { select: { id: true, name: true } },
          entries: { orderBy: [{ spentOn: 'asc' }, { createdAt: 'asc' }] },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
      });
      return sendSuccess(response, months);
    }),
  );

  router.put(
    '/households/:householdId/variable-expenses/month',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = upsertVariableMonthSchema.parse(request.body);
      await memberAccess(prisma, request);
      await requireHouseholdCategory(prisma, { householdId, categoryId: body.categoryId });
      await validateScope(prisma, householdId, body.scope, body.personalPersonId);
      const key = ownerKey(body.scope, body.personalPersonId);
      const item = await runSerializableTransaction(prisma, async (database) => {
        const existing = await database.variableExpenseMonth.findUnique({
          where: {
            householdId_categoryId_ownerKey_year_month: {
              householdId,
              categoryId: body.categoryId,
              ownerKey: key,
              year: body.year,
              month: body.month,
            },
          },
        });
        const month = existing
          ? await database.variableExpenseMonth.update({
              where: { id: existing.id },
              data: {
                scope: body.scope,
                personalPersonId: body.personalPersonId ?? null,
                entryMode: body.entryMode,
                summaryAmountCents:
                  body.entryMode === 'SUMMARY' ? body.summaryAmountCents : null,
                isComplete: body.isComplete,
                notes: body.notes ?? null,
              },
            })
          : await database.variableExpenseMonth.create({
              data: {
                householdId,
                categoryId: body.categoryId,
                ownerKey: key,
                scope: body.scope,
                personalPersonId: body.personalPersonId ?? null,
                year: body.year,
                month: body.month,
                entryMode: body.entryMode,
                summaryAmountCents:
                  body.entryMode === 'SUMMARY' ? body.summaryAmountCents : null,
                isComplete: body.isComplete,
                notes: body.notes ?? null,
              },
            });
        if (body.entryMode === 'SUMMARY' || body.entries) {
          await database.variableExpenseEntry.deleteMany({
            where: { variableExpenseMonthId: month.id },
          });
        }
        if (body.entryMode === 'DETAIL' && body.entries?.length) {
          await database.variableExpenseEntry.createMany({
            data: body.entries.map((entry) => ({
              variableExpenseMonthId: month.id,
              spentOn: entry.spentOn,
              merchant: entry.merchant ?? null,
              amountCents: entry.amountCents,
              notes: entry.notes ?? null,
            })),
          });
        }
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: existing ? 'EXPENSE_CHANGED' : 'EXPENSE_CREATED',
          resourceType: 'VariableExpenseMonth',
          resourceId: month.id,
        });
        return database.variableExpenseMonth.findUnique({
          where: { id: month.id },
          include: { category: true, personalPerson: true, entries: { orderBy: { spentOn: 'asc' } } },
        });
      });
      return sendSuccess(response, item, { statusCode: 200 });
    }),
  );

  router.get(
    '/households/:householdId/variable-expenses/statistics',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = variableQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const household = await prisma.household.findUnique({ where: { id: householdId } });
      const months = await prisma.variableExpenseMonth.findMany({
        where: {
          householdId,
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(query.ownerKey ? { ownerKey: query.ownerKey } : {}),
        },
        include: { category: true, entries: true },
      });
      const groups = new Map();
      months.forEach((month) => {
        const key = `${month.categoryId}:${month.ownerKey}`;
        const current = groups.get(key) ?? [];
        current.push(month);
        groups.set(key, current);
      });
      const statistics = [...groups.values()].map((items) => ({
        categoryId: items[0].categoryId,
        ownerKey: items[0].ownerKey,
        scope: items[0].scope,
        personalPersonId: items[0].personalPersonId,
        category: items[0].category,
        ...calculateVariableStatistics(items, {
          calculationDate: dateOrToday(),
          householdMarginBps: household.safetyMarginBps,
          categoryMarginBps: items[0].category.safetyMarginBps,
        }),
      }));
      return sendSuccess(response, statistics);
    }),
  );

  router.delete(
    '/households/:householdId/variable-expenses/:variableMonthId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, variableMonthId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      await getVariableMonth(prisma, householdId, variableMonthId);
      await prisma.$transaction(async (database) => {
        await database.variableExpenseEntry.deleteMany({
          where: { variableExpenseMonthId: variableMonthId },
        });
        await database.variableExpenseMonth.delete({ where: { id: variableMonthId } });
      });
      return sendSuccess(response, { id: variableMonthId, deleted: true });
    }),
  );

  router.get(
    '/households/:householdId/budget',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      const { budget } = await calculateHouseholdBudget(prisma, householdId);
      return sendSuccess(response, budget);
    }),
  );

  router.get(
    '/households/:householdId/dashboard',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = calculationQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      return sendSuccess(
        response,
        await calculateDashboard(prisma, householdId, query.date, query.balanceCents),
      );
    }),
  );

  router.patch(
    '/households/:householdId/balance',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = updateBalanceSchema.parse(request.body);
      await memberAccess(prisma, request);
      const result = await prisma.$transaction(async (database) => {
        const household = await database.household.update({
          where: { id: householdId },
          data: { currentBalanceCents: body.balanceCents },
        });
        const snapshot = await database.householdBalanceSnapshot.create({
          data: {
            householdId,
            recordedByUserId: request.auth.userId,
            balanceCents: body.balanceCents,
            source: 'MANUAL',
          },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'BALANCE_CHANGED',
          resourceType: 'Household',
          resourceId: householdId,
          metadata: { balanceCents: body.balanceCents },
        });
        return { household, snapshot };
      });
      return sendSuccess(response, result);
    }),
  );

  router.get(
    '/households/:householdId/plannings',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = planningQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const plannings = await prisma.monthlyPlanning.findMany({
        where: {
          householdId,
          ...(query.year ? { year: query.year } : {}),
          ...(query.month ? { month: query.month } : {}),
        },
        include: { contributions: { orderBy: { personName: 'asc' } }, recoveryPlans: true },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      });
      return sendSuccess(response, plannings);
    }),
  );

  router.post(
    '/households/:householdId/plannings/prepare',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = prepareMonthSchema.parse(request.body);
      await memberAccess(prisma, request);
      const dashboard = await calculateDashboard(
        prisma,
        householdId,
        body.calculationDate,
        body.confirmedBalanceCents,
      );
      if (!dashboard.budget.readiness.ready) {
        throw createDomainError(
          409,
          'BUDGET_NOT_READY',
          'Completa las personas y su reparto antes de preparar el mes.',
          dashboard.budget.readiness,
        );
      }
      const date = body.calculationDate;
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const temporaryAdjustments = dashboard.activeRecoveryPlan
        ? new Map(
            distributeTemporaryAdjustment(
              dashboard.activeRecoveryPlan.monthlyAdjustmentCents,
              dashboard.budget.contributions.map((contribution) => ({
                id: contribution.personId,
                contributionBps: contribution.contributionBps,
              })),
            ).map((item) => [item.personId, item.temporaryAdjustmentCents]),
          )
        : new Map();
      const result = await runSerializableTransaction(prisma, async (database) => {
        const previous = await database.monthlyPlanning.findUnique({
          where: { householdId_year_month: { householdId, year, month } },
        });
        if (previous) {
          await database.monthlyPlanningContribution.deleteMany({
            where: { monthlyPlanningId: previous.id },
          });
          await database.householdBalanceSnapshot.deleteMany({
            where: { monthlyPlanningId: previous.id },
          });
        }
        const data = {
          householdId,
          preparedByUserId: request.auth.userId,
          year,
          month,
          calculationDate: date,
          confirmedBalanceCents: body.confirmedBalanceCents,
          recommendedBudgetCents: dashboard.budget.recommendedBudgetCents,
          householdBudgetCents: dashboard.budget.householdBudgetCents,
          theoreticalReserveCents: dashboard.theoreticalReserveCents,
          relevantAvailableBalanceCents: body.confirmedBalanceCents,
          deficitCents: dashboard.deficitCents,
          financialStatus: dashboard.financialStatus,
          calculationVersion: dashboard.budget.calculationVersion,
          breakdown: jsonValue({
            budget: dashboard.budget,
            reserveLines: dashboard.reserveLines,
            upcomingPayments: dashboard.upcomingPayments,
          }),
          preparedAt: new Date(),
        };
        const planning = previous
          ? await database.monthlyPlanning.update({ where: { id: previous.id }, data })
          : await database.monthlyPlanning.create({ data });
        await database.monthlyPlanningContribution.createMany({
          data: dashboard.budget.contributions.map((contribution) => {
            const temporaryAdjustmentCents =
              temporaryAdjustments.get(contribution.personId) ?? 0;
            return {
              monthlyPlanningId: planning.id,
              householdPersonId: contribution.personId,
              personName: contribution.personName,
              contributionBps: contribution.contributionBps,
              standardHouseholdCents: contribution.standardHouseholdCents,
              personalExpenseCents: contribution.personalExpenseCents,
              temporaryAdjustmentCents,
              totalRecommendedCents:
                contribution.totalStandardCents + temporaryAdjustmentCents,
            };
          }),
        });
        await database.household.update({
          where: { id: householdId },
          data: { currentBalanceCents: body.confirmedBalanceCents },
        });
        await database.householdBalanceSnapshot.create({
          data: {
            householdId,
            recordedByUserId: request.auth.userId,
            monthlyPlanningId: planning.id,
            balanceCents: body.confirmedBalanceCents,
            source: 'MONTHLY_PREPARATION',
          },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'MONTH_PREPARED',
          resourceType: 'MonthlyPlanning',
          resourceId: planning.id,
          metadata: { year, month, calculationVersion: 'v1' },
        });
        return database.monthlyPlanning.findUnique({
          where: { id: planning.id },
          include: { contributions: { orderBy: { personName: 'asc' } } },
        });
      });
      return sendSuccess(response, result, { statusCode: 201 });
    }),
  );

  router.patch(
    '/households/:householdId/plannings/:planningId/fund',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, planningId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      const existing = await prisma.monthlyPlanning.findFirst({ where: { id: planningId, householdId } });
      if (!existing) {
        throw createDomainError(404, 'PLANNING_NOT_FOUND', 'No se encontró la planificación.');
      }
      const planning = await prisma.monthlyPlanning.update({
        where: { id: planningId },
        data: { fundingStatus: 'FUNDED', fundedAt: new Date() },
        include: { contributions: true },
      });
      return sendSuccess(response, planning);
    }),
  );

  router.get(
    '/households/:householdId/simulation',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = calculationQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      return sendSuccess(
        response,
        await calculateHouseholdSimulation(prisma, householdId, query.date, query.balanceCents),
      );
    }),
  );

  router.post(
    '/households/:householdId/recovery-plans/preview',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = recoveryPreviewSchema.parse(request.body);
      await memberAccess(prisma, request);
      const { inputs, budget } = await calculateHouseholdBudget(prisma, householdId);
      if (!budget.readiness.ready) {
        throw createDomainError(
          409,
          'BUDGET_NOT_READY',
          'Completa las personas y su reparto antes de simular una recuperación.',
          budget.readiness,
        );
      }
      const startsOn = body.startsOn ?? dateOrToday();
      const preview = previewRecoveryPlan({
        ...body,
        startsOn,
        upcomingPayments: upcomingPayments(inputs.recurringExpenses, startsOn),
        relevantAvailableBalanceCents: inputs.household.currentBalanceCents,
        standardMonthlyBudgetCents: budget.householdBudgetCents,
      });
      return sendSuccess(response, {
        ...preview,
        startsOn: toIsoDate(startsOn),
        targetCompletionDate: toIsoDate(addCalendarMonths(startsOn, preview.estimatedMonths)),
        distribution: distributeTemporaryAdjustment(
          preview.monthlyAdjustmentCents,
          inputs.household.people,
        ),
      });
    }),
  );

  router.post(
    '/households/:householdId/recovery-plans',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const body = recoveryPreviewSchema.parse(request.body);
      await memberAccess(prisma, request);
      const { inputs, budget } = await calculateHouseholdBudget(prisma, householdId);
      if (!budget.readiness.ready) {
        throw createDomainError(
          409,
          'BUDGET_NOT_READY',
          'Completa las personas y su reparto antes de crear una recuperación.',
          budget.readiness,
        );
      }
      const startsOn = body.startsOn ?? dateOrToday();
      const preview = previewRecoveryPlan({
        ...body,
        startsOn,
        upcomingPayments: upcomingPayments(inputs.recurringExpenses, startsOn),
        relevantAvailableBalanceCents: inputs.household.currentBalanceCents,
        standardMonthlyBudgetCents: budget.householdBudgetCents,
      });
      if (body.monthlyPlanningId) {
        const planning = await prisma.monthlyPlanning.findFirst({
          where: { id: body.monthlyPlanningId, householdId },
        });
        if (!planning) {
          throw createDomainError(404, 'PLANNING_NOT_FOUND', 'No se encontró la planificación.');
        }
      }
      const targetCompletionDate = addCalendarMonths(startsOn, preview.estimatedMonths);
      const plan = await prisma.$transaction(async (database) => {
        await database.recoveryPlan.updateMany({
          where: { householdId, status: 'ACTIVE' },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        const created = await database.recoveryPlan.create({
          data: {
            householdId,
            monthlyPlanningId: body.monthlyPlanningId ?? null,
            createdByUserId: request.auth.userId,
            mode: body.mode,
            initialDeficitCents: body.deficitCents,
            remainingDeficitCents: body.deficitCents,
            targetMonths: preview.targetMonths,
            maximumMonthlyCents: preview.maximumMonthlyCents,
            monthlyAdjustmentCents: preview.monthlyAdjustmentCents,
            startsOn,
            targetCompletionDate,
          },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId,
          action: 'RECOVERY_PLAN_CHANGED',
          resourceType: 'RecoveryPlan',
          resourceId: created.id,
        });
        return created;
      });
      return sendSuccess(response, plan, { statusCode: 201 });
    }),
  );

  router.get(
    '/households/:householdId/recovery-plans',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      await memberAccess(prisma, request);
      const plans = await prisma.recoveryPlan.findMany({
        where: { householdId },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(response, plans);
    }),
  );

  router.patch(
    '/households/:householdId/recovery-plans/:recoveryPlanId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, recoveryPlanId } = financeParamsSchema.parse(request.params);
      const body = updateRecoverySchema.parse(request.body);
      await memberAccess(prisma, request);
      const existing = await prisma.recoveryPlan.findFirst({ where: { id: recoveryPlanId, householdId } });
      if (!existing) {
        throw createDomainError(404, 'RECOVERY_PLAN_NOT_FOUND', 'No se encontró el plan de recuperación.');
      }
      const plan = await prisma.recoveryPlan.update({
        where: { id: recoveryPlanId },
        data:
          body.status === 'COMPLETED'
            ? { status: body.status, remainingDeficitCents: 0, completedAt: new Date() }
            : { status: body.status, cancelledAt: new Date() },
      });
      return sendSuccess(response, plan);
    }),
  );

  router.get(
    '/households/:householdId/calendar',
    asyncRoute(async (request, response) => {
      const { householdId } = financeParamsSchema.parse(request.params);
      const query = calendarQuerySchema.parse(request.query);
      await memberAccess(prisma, request);
      const today = dateOrToday();
      const anchorDate = query.anchorDate ?? today;
      const expenses = await prisma.recurringExpense.findMany({
        where: { householdId },
        include: { category: true, personalPerson: { select: { id: true, name: true } } },
      });
      const payments = await prisma.expensePayment.findMany({
        where: { recurringExpense: { householdId } },
      });
      return sendSuccess(
        response,
        buildCalendar({ recurringExpenses: expenses, payments, today, view: query.view, anchorDate }),
      );
    }),
  );

  return router;
};
