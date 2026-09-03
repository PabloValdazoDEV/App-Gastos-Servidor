import { createAuditLog } from '../household-domain/audit.js';
import { assertDomain } from '../household-domain/domainError.js';
import { throwMappedPrismaError } from '../household-domain/prismaErrors.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  HOUSEHOLD_ROLES,
  requireHouseholdCategory,
  requireHouseholdRole,
} from '../households/authorization.js';
import { createCategorySlug } from './categorySlug.js';

const assertValidSlug = (slug) =>
  assertDomain(
    slug.length > 0,
    400,
    'INVALID_CATEGORY_SLUG',
    'El nombre necesita al menos una letra o número para generar el identificador.',
  );

const auditCategory = (
  database,
  { actorUserId, householdId, categoryId, action, operation, changedFields },
) =>
  createAuditLog(database, {
    actorUserId,
    householdId,
    action,
    resourceType: 'Category',
    resourceId: categoryId,
    metadata: {
      operation,
      ...(changedFields ? { changedFields } : {}),
    },
  });

export const createCategoriesService = ({ prisma }) => {
  if (!prisma) throw new TypeError('createCategoriesService requires prisma.');

  return {
    async list({ actorUserId, householdId, includeArchived }) {
      const access = await requireHouseholdRole(prisma, {
        householdId,
        userId: actorUserId,
      });
      const categories = await prisma.category.findMany({
        where: {
          householdId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [
          { archivedAt: { sort: 'asc', nulls: 'first' } },
          { isDefault: 'desc' },
          { name: 'asc' },
        ],
      });

      return {
        householdSafetyMarginBps: access.household.safetyMarginBps,
        categories,
      };
    },

    async create({ actorUserId, householdId, input }) {
      const slug = input.slug ?? createCategorySlug(input.name);
      assertValidSlug(slug);

      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          await requireHouseholdRole(tx, {
            householdId,
            userId: actorUserId,
            minimumRole: HOUSEHOLD_ROLES.ADMIN,
          });
          const category = await tx.category.create({
            data: {
              householdId,
              name: input.name,
              slug,
              icon: input.icon,
              color: input.color,
              safetyMarginBps: input.safetyMarginBps ?? null,
            },
          });

          await auditCategory(tx, {
            actorUserId,
            householdId,
            categoryId: category.id,
            action: 'CATEGORY_CREATED',
            operation: 'CREATED',
          });

          return category;
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          uniqueCode: 'CATEGORY_SLUG_CONFLICT',
          uniqueMessage: 'Ya existe una categoría con ese identificador.',
        });
      }
    },

    async update({ actorUserId, householdId, categoryId, input }) {
      const data = { ...input };
      if (input.name !== undefined && input.slug === undefined) {
        data.slug = createCategorySlug(input.name);
        assertValidSlug(data.slug);
      }

      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          await requireHouseholdRole(tx, {
            householdId,
            userId: actorUserId,
            minimumRole: HOUSEHOLD_ROLES.ADMIN,
          });
          await requireHouseholdCategory(tx, { householdId, categoryId });
          const category = await tx.category.update({
            where: { id: categoryId },
            data,
          });

          await auditCategory(tx, {
            actorUserId,
            householdId,
            categoryId,
            action: 'CATEGORY_CHANGED',
            operation: 'UPDATED',
            changedFields: Object.keys(data).sort(),
          });

          return category;
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          uniqueCode: 'CATEGORY_SLUG_CONFLICT',
          uniqueMessage: 'Ya existe una categoría con ese identificador.',
          notFoundCode: 'CATEGORY_NOT_FOUND',
          notFoundMessage: 'No se encontró la categoría solicitada.',
        });
      }
    },

    async archive({ actorUserId, householdId, categoryId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.ADMIN,
        });
        await requireHouseholdCategory(tx, { householdId, categoryId });
        const category = await tx.category.update({
          where: { id: categoryId },
          data: { archivedAt: new Date() },
        });

        await auditCategory(tx, {
          actorUserId,
          householdId,
          categoryId,
          action: 'CATEGORY_CHANGED',
          operation: 'ARCHIVED',
        });

        return category;
      });
    },

    async remove({ actorUserId, householdId, categoryId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.OWNER,
        });
        await requireHouseholdCategory(tx, {
          householdId,
          categoryId,
          includeArchived: true,
        });
        const [recurringExpenses, utilityInvoices, variableMonths] =
          await Promise.all([
            tx.recurringExpense.count({ where: { categoryId, householdId } }),
            tx.utilityInvoice.count({ where: { categoryId, householdId } }),
            tx.variableExpenseMonth.count({ where: { categoryId, householdId } }),
          ]);
        const dependencyCount =
          recurringExpenses + utilityInvoices + variableMonths;

        assertDomain(
          dependencyCount === 0,
          409,
          'CATEGORY_HAS_DEPENDENCIES',
          'La categoría tiene datos asociados. Archívala para conservar el histórico.',
          [
            {
              recurringExpenses,
              utilityInvoices,
              variableExpenseMonths: variableMonths,
            },
          ],
        );

        await tx.category.delete({ where: { id: categoryId } });
        await auditCategory(tx, {
          actorUserId,
          householdId,
          categoryId,
          action: 'CATEGORY_CHANGED',
          operation: 'DELETED_WITHOUT_DEPENDENCIES',
        });

        return { id: categoryId, deleted: true };
      });
    },
  };
};
