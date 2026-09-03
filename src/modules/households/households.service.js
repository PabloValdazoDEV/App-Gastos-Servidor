import { createAuditLog } from '../household-domain/audit.js';
import { assertDomain } from '../household-domain/domainError.js';
import { throwMappedPrismaError } from '../household-domain/prismaErrors.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  HOUSEHOLD_ROLES,
  requireHouseholdRole,
} from './authorization.js';
import { DEFAULT_CATEGORIES } from './defaultCategories.js';
import { validateContributionDistribution } from './distribution.js';

const resolveDefaults = (defaults = {}) => ({
  currency: defaults.currency ?? 'EUR',
  timezone: defaults.timezone ?? 'Europe/Madrid',
  locale: defaults.locale ?? 'es-ES',
  safetyMarginBps: Math.round((defaults.safetyMarginPercent ?? 10) * 100),
  contributionDay: defaults.contributionDay ?? 1,
});

const validateInitialPeople = (mode, people) =>
  validateContributionDistribution(
    mode,
    people.map((person) => ({ ...person, archivedAt: null })),
  );

export const createHouseholdsService = ({ prisma, defaults }) => {
  if (!prisma) {
    throw new TypeError('createHouseholdsService requires prisma.');
  }

  const configuredDefaults = resolveDefaults(defaults);

  return {
    async list({ actorUserId, page, pageSize, includeArchived }) {
      const where = {
        userId: actorUserId,
        isActive: true,
        revokedAt: null,
        ...(!includeArchived ? { household: { isActive: true } } : {}),
      };
      const [accesses, total] = await Promise.all([
        prisma.householdUserAccess.findMany({
          where,
          include: {
            household: {
              include: {
                _count: {
                  select: {
                    people: true,
                    categories: true,
                    accesses: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.householdUserAccess.count({ where }),
      ]);

      return {
        items: accesses.map((access) => ({
          ...access.household,
          access: {
            id: access.id,
            role: access.role,
            createdAt: access.createdAt,
          },
        })),
        meta: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    },

    async create({ actorUserId, input }) {
      validateInitialPeople(input.contributionMode, input.people);

      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          const household = await tx.household.create({
            data: {
              ownerUserId: actorUserId,
              name: input.name,
              currency: input.currency ?? configuredDefaults.currency,
              timezone: input.timezone ?? configuredDefaults.timezone,
              locale: input.locale ?? configuredDefaults.locale,
              contributionMode: input.contributionMode,
              safetyMarginBps:
                input.safetyMarginBps ?? configuredDefaults.safetyMarginBps,
              contributionDay:
                input.contributionDay ?? configuredDefaults.contributionDay,
              currentBalanceCents: input.currentBalanceCents,
            },
          });

          await tx.householdUserAccess.create({
            data: {
              householdId: household.id,
              userId: actorUserId,
              role: HOUSEHOLD_ROLES.OWNER,
            },
          });

          if (input.people.length > 0) {
            await tx.householdPerson.createMany({
              data: input.people.map((person) => ({
                householdId: household.id,
                linkedUserId: person.linkCurrentUser ? actorUserId : null,
                name: person.name,
                email: person.email ?? null,
                contributionBps: person.contributionBps,
                fixedContributionCents:
                  person.fixedContributionCents ?? null,
                isActive: person.isActive,
              })),
            });
          }

          await tx.category.createMany({
            data: DEFAULT_CATEGORIES.map((category) => ({
              householdId: household.id,
              ...category,
              isDefault: true,
            })),
          });

          await createAuditLog(tx, {
            actorUserId,
            householdId: household.id,
            action: 'HOUSEHOLD_CREATED',
            resourceType: 'Household',
            resourceId: household.id,
            metadata: {
              contributionMode: household.contributionMode,
              initialPeopleCount: input.people.length,
              defaultCategoryCount: DEFAULT_CATEGORIES.length,
            },
          });

          return {
            ...household,
            access: { role: HOUSEHOLD_ROLES.OWNER },
            defaultCategoryCount: DEFAULT_CATEGORIES.length,
          };
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          uniqueCode: 'HOUSEHOLD_CREATE_CONFLICT',
          uniqueMessage: 'No se pudo crear el hogar por un conflicto de datos.',
        });
      }
    },

    async get({ actorUserId, householdId }) {
      const access = await requireHouseholdRole(prisma, {
        householdId,
        userId: actorUserId,
        allowInactiveHousehold: true,
      });

      const counts = await prisma.household.findUnique({
        where: { id: householdId },
        select: {
          _count: {
            select: { people: true, categories: true, accesses: true },
          },
        },
      });

      return {
        ...access.household,
        access: { id: access.id, role: access.role },
        _count: counts?._count,
      };
    },

    async update({ actorUserId, householdId, input }) {
      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          const access = await requireHouseholdRole(tx, {
            householdId,
            userId: actorUserId,
            minimumRole: HOUSEHOLD_ROLES.ADMIN,
          });
          const contributionMode =
            input.contributionMode ?? access.household.contributionMode;

          if (
            input.contributionMode !== undefined &&
            input.contributionMode !== access.household.contributionMode
          ) {
            const people = await tx.householdPerson.findMany({
              where: { householdId, archivedAt: null },
            });
            validateContributionDistribution(contributionMode, people);
          }

          const household = await tx.household.update({
            where: { id: householdId },
            data: input,
          });

          await createAuditLog(tx, {
            actorUserId,
            householdId,
            action: 'HOUSEHOLD_CHANGED',
            resourceType: 'Household',
            resourceId: householdId,
            metadata: { changedFields: Object.keys(input).sort() },
          });

          return household;
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          notFoundCode: 'HOUSEHOLD_NOT_FOUND',
          notFoundMessage: 'No se encontró el hogar solicitado.',
        });
      }
    },

    async archive({ actorUserId, householdId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.OWNER,
        });

        const updated = await tx.household.updateMany({
          where: { id: householdId, ownerUserId: actorUserId, isActive: true },
          data: { isActive: false },
        });

        assertDomain(
          updated.count === 1,
          409,
          'HOUSEHOLD_ARCHIVE_CONFLICT',
          'El hogar ya no puede archivarse con el estado actual.',
        );

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'HOUSEHOLD_DELETED',
          resourceType: 'Household',
          resourceId: householdId,
          metadata: { deletionMode: 'ARCHIVE' },
        });

        return { id: householdId, isActive: false };
      });
    },
  };
};

