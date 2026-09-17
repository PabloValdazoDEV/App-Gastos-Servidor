import { resolveBudgetMargin } from '../../services/budgetCalculator.service.js';
import { sendSuccess } from '../../utils/httpResponses.js';
import { requireHouseholdCategory, requireHouseholdPerson } from '../households/authorization.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { budgetMarginPreferenceSchema, budgetMarginPreferenceQuerySchema, financeParamsSchema } from './finance.schemas.js';
import { visibleExpenseWhere } from './finance.service.js';
import { budgetMarginOwnerKey } from './budgetMarginPreference.service.js';

const preferenceInclude = {
  category: true,
  personalPerson: { select: { id: true, name: true } },
};

function withMargin(preference, household) {
  return {
    ...preference,
    ...resolveBudgetMargin({
      applySafetyMargin: preference.applySafetyMargin,
      categoryMarginBps: preference.category.safetyMarginBps,
      householdMarginBps: household.safetyMarginBps,
    }),
  };
}

export function registerBudgetMarginPreferenceRoutes({ router, prisma, requireCsrf, memberAccess }) {
  const path = '/households/:householdId/budget-margin-preferences';

  router.get(path, asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    const query = budgetMarginPreferenceQuerySchema.parse(request.query);
    const access = await memberAccess(prisma, request);
    // Only persisted preferences are returned. A missing group means disabled.
    const preferences = await prisma.budgetMarginPreference.findMany({
      where: { householdId, ...query, ...visibleExpenseWhere(request.auth.userId) },
      include: preferenceInclude,
      orderBy: [{ expenseType: 'asc' }, { categoryId: 'asc' }, { ownerKey: 'asc' }],
    });
    return sendSuccess(response, preferences.map((item) => withMargin(item, access.household)));
  }));

  router.put(path, requireCsrf, asyncRoute(async (request, response) => {
    const { householdId } = financeParamsSchema.parse(request.params);
    const body = budgetMarginPreferenceSchema.parse(request.body);
    const preference = await runSerializableTransaction(prisma, async (database) => {
      const access = await memberAccess(database, request);
      await requireHouseholdCategory(database, { householdId, categoryId: body.categoryId });
      if (body.scope === 'PERSONAL') {
        const person = await requireHouseholdPerson(database, { householdId, personId: body.personalPersonId });
        if (!person.isActive || person.linkedUserId !== request.auth.userId) {
          throw createDomainError(404, 'HOUSEHOLD_PERSON_NOT_FOUND', 'No se encontró la persona solicitada.');
        }
      }
      const ownerKey = budgetMarginOwnerKey(body);
      const group = { householdId, expenseType: body.expenseType, categoryId: body.categoryId, ownerKey };
      const item = await database.budgetMarginPreference.upsert({
        where: { householdId_expenseType_categoryId_ownerKey: group },
        create: { ...body, ...group, personalPersonId: body.personalPersonId ?? null },
        update: { applySafetyMargin: body.applySafetyMargin },
        include: preferenceInclude,
      });
      await createAuditLog(database, {
        actorUserId: request.auth.userId,
        householdId,
        action: 'EXPENSE_CHANGED',
        resourceType: 'BudgetMarginPreference',
        resourceId: item.id,
        metadata: { ...group, applySafetyMargin: item.applySafetyMargin },
      });
      return withMargin(item, access.household);
    });
    return sendSuccess(response, preference);
  }));
}
