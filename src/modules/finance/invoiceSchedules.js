import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { businessToday } from '../../services/businessClock.service.js';
import { addCalendarMonths, toCivilDate, toIsoDate } from '../../services/date.service.js';
import { estimateScheduleAmount, scheduleOccurrences } from '../../services/invoiceSchedule.service.js';
import { financeParamsSchema, invoiceScheduleSchema } from './finance.schemas.js';
import { visibleExpenseWhere } from './finance.service.js';

const MONTH_FREQUENCIES = new Set(['MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'YEARLY', 'CUSTOM_MONTHS']);
const include = { category: true, personalPerson: { select: { id: true, name: true } } };

const scheduleData = (body) => ({
  categoryId: body.categoryId,
  name: body.name,
  scope: body.scope,
  personalPersonId: body.scope === 'PERSONAL' ? body.personalPersonId : null,
  frequency: body.frequency,
  intervalMonths: body.intervalMonths,
  intervalWeeks: body.intervalWeeks,
  // "Around the 10th": month-based bills keep their day when months are shorter.
  usualDayOfMonth: MONTH_FREQUENCIES.has(body.frequency) ? toCivilDate(body.nextExpectedDate).getUTCDate() : null,
  nextExpectedDate: body.nextExpectedDate,
  endDate: body.endDate ?? null,
  ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
});

/*
 * Repeating bills visible to the user, each with its estimated amount and the
 * next expected dates. Older test doubles without the model get an empty list.
 */
export async function loadInvoiceForecasts(database, { householdId, actorUserId, scope }) {
  if (!database.invoiceSchedule?.findMany) return [];
  const schedules = await database.invoiceSchedule.findMany({
    where: { householdId, ...visibleExpenseWhere(actorUserId, scope) },
    include,
    orderBy: [{ isActive: 'desc' }, { nextExpectedDate: 'asc' }],
  });
  if (!schedules.length) return [];
  const history = await database.utilityInvoice.findMany({
    where: {
      householdId,
      ...visibleExpenseWhere(actorUserId),
      categoryId: { in: [...new Set(schedules.map((schedule) => schedule.categoryId))] },
    },
    select: { scheduleId: true, categoryId: true, scope: true, personalPersonId: true, invoiceDate: true, amountCents: true },
    orderBy: { invoiceDate: 'desc' },
    take: 500,
  });
  return schedules.map((schedule) => ({ ...schedule, estimate: estimateScheduleAmount(schedule, history) }));
}

export function registerInvoiceScheduleRoutes(router, { prisma, requireCsrf, memberAccess, requireHouseholdCategory, validateScope }) {
  async function findVisible(request) {
    const { householdId, scheduleId } = financeParamsSchema.parse(request.params);
    const schedule = await prisma.invoiceSchedule.findFirst({
      where: { id: scheduleId, householdId, ...visibleExpenseWhere(request.auth.userId) },
    });
    if (!schedule) throw createDomainError(404, 'INVOICE_SCHEDULE_NOT_FOUND', 'No se encontró la factura periódica.');
    return schedule;
  }

  async function validateBody(householdId, body) {
    await requireHouseholdCategory(prisma, { householdId, categoryId: body.categoryId });
    await validateScope(prisma, householdId, body.scope, body.personalPersonId);
  }

  router.get('/households/:householdId/invoice-schedules', asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    await memberAccess(prisma, request);
    const today = businessToday();
    const schedules = await loadInvoiceForecasts(prisma, { householdId, actorUserId: request.auth.userId });
    return sendSuccess(response, schedules.map((schedule) => ({
      ...schedule,
      upcomingDates: scheduleOccurrences(schedule, schedule.nextExpectedDate, addCalendarMonths(today, 13)).slice(0, 3),
    })));
  }));

  router.post('/households/:householdId/invoice-schedules', requireCsrf, asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    const body = invoiceScheduleSchema.parse(request.body);
    await memberAccess(prisma, request);
    await validateBody(householdId, body);
    const schedule = await prisma.$transaction(async (database) => {
      const created = await database.invoiceSchedule.create({ data: { householdId, ...scheduleData(body) }, include });
      await createAuditLog(database, {
        actorUserId: request.auth.userId, householdId, action: 'EXPENSE_CREATED',
        resourceType: 'InvoiceSchedule', resourceId: created.id,
      });
      return created;
    });
    return sendSuccess(response, schedule, { statusCode: 201 });
  }));

  router.put('/households/:householdId/invoice-schedules/:scheduleId', requireCsrf, asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    const body = invoiceScheduleSchema.parse(request.body);
    await memberAccess(prisma, request);
    const existing = await findVisible(request);
    await validateBody(householdId, body);
    const schedule = await prisma.$transaction(async (database) => {
      const updated = await database.invoiceSchedule.update({ where: { id: existing.id }, data: scheduleData(body), include });
      await createAuditLog(database, {
        actorUserId: request.auth.userId, householdId, action: 'EXPENSE_CHANGED',
        resourceType: 'InvoiceSchedule', resourceId: existing.id,
      });
      return updated;
    });
    return sendSuccess(response, schedule);
  }));

  // Deleting the schedule keeps every real bill; they just lose the link.
  router.delete('/households/:householdId/invoice-schedules/:scheduleId', requireCsrf, asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    await memberAccess(prisma, request);
    const existing = await findVisible(request);
    await prisma.$transaction(async (database) => {
      await database.invoiceSchedule.delete({ where: { id: existing.id } });
      await createAuditLog(database, {
        actorUserId: request.auth.userId, householdId, action: 'EXPENSE_DELETED',
        resourceType: 'InvoiceSchedule', resourceId: existing.id,
      });
    });
    return sendSuccess(response, { deleted: true, id: existing.id, nextExpectedDate: toIsoDate(existing.nextExpectedDate) });
  }));
}
