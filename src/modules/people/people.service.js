import { createAuditLog } from '../household-domain/audit.js';
import { assertDomain } from '../household-domain/domainError.js';
import { throwMappedPrismaError } from '../household-domain/prismaErrors.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  HOUSEHOLD_ROLES,
  requireHouseholdPerson,
  requireHouseholdRole,
} from '../households/authorization.js';
import { validateContributionDistribution } from '../households/distribution.js';

const ensureAvailableEmail = async (
  database,
  { householdId, email, excludedPersonId },
) => {
  if (!email) return;

  const duplicate = await database.householdPerson.findFirst({
    where: {
      householdId,
      email: { equals: email, mode: 'insensitive' },
      archivedAt: null,
      ...(excludedPersonId ? { id: { not: excludedPersonId } } : {}),
    },
    select: { id: true },
  });

  assertDomain(
    !duplicate,
    409,
    'HOUSEHOLD_PERSON_EMAIL_CONFLICT',
    'Ya existe una persona activa con ese correo en el hogar.',
  );
};

const getDistributionPeople = (database, householdId) =>
  database.householdPerson.findMany({
    where: { householdId, archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const auditPersonChange = (
  database,
  { actorUserId, householdId, personId, operation, changedFields },
) =>
  createAuditLog(database, {
    actorUserId,
    householdId,
    action: 'HOUSEHOLD_CHANGED',
    resourceType: 'HouseholdPerson',
    resourceId: personId,
    metadata: {
      operation,
      ...(changedFields ? { changedFields } : {}),
    },
  });

export const createPeopleService = ({ prisma }) => {
  if (!prisma) throw new TypeError('createPeopleService requires prisma.');

  return {
    async list({ actorUserId, householdId, includeArchived }) {
      const access = await requireHouseholdRole(prisma, {
        householdId,
        userId: actorUserId,
      });
      const people = await prisma.householdPerson.findMany({
        where: {
          householdId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        select: {
          id: true,
          name: true,
          email: true,
          linkedUserId: true,
          contributionBps: true,
          fixedContributionCents: true,
          isActive: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });

      return {
        contributionMode: access.household.contributionMode,
        people,
      };
    },

    async create({ actorUserId, householdId, input }) {
      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          const access = await requireHouseholdRole(tx, {
            householdId,
            userId: actorUserId,
            minimumRole: HOUSEHOLD_ROLES.ADMIN,
          });
          await ensureAvailableEmail(tx, {
            householdId,
            email: input.email,
          });

          const person = await tx.householdPerson.create({
            data: {
              householdId,
              name: input.name,
              email: input.email ?? null,
              contributionBps: input.contributionBps,
              fixedContributionCents:
                input.fixedContributionCents ?? null,
              isActive: input.isActive,
            },
          });
          const people = await getDistributionPeople(tx, householdId);
          validateContributionDistribution(
            access.household.contributionMode,
            people,
          );

          await auditPersonChange(tx, {
            actorUserId,
            householdId,
            personId: person.id,
            operation: 'CREATED',
          });

          return person;
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          uniqueCode: 'HOUSEHOLD_PERSON_CONFLICT',
          uniqueMessage: 'La persona no pudo crearse por un conflicto de datos.',
        });
      }
    },

    async update({ actorUserId, householdId, personId, input }) {
      try {
        return await runSerializableTransaction(prisma, async (tx) => {
          const access = await requireHouseholdRole(tx, {
            householdId,
            userId: actorUserId,
            minimumRole: HOUSEHOLD_ROLES.ADMIN,
          });
          await requireHouseholdPerson(tx, { householdId, personId });
          await ensureAvailableEmail(tx, {
            householdId,
            email: input.email,
            excludedPersonId: personId,
          });

          const person = await tx.householdPerson.update({
            where: { id: personId },
            data: input,
          });
          const people = await getDistributionPeople(tx, householdId);
          validateContributionDistribution(
            access.household.contributionMode,
            people,
          );

          await auditPersonChange(tx, {
            actorUserId,
            householdId,
            personId,
            operation: 'UPDATED',
            changedFields: Object.keys(input).sort(),
          });

          return person;
        });
      } catch (error) {
        throwMappedPrismaError(error, {
          notFoundCode: 'HOUSEHOLD_PERSON_NOT_FOUND',
          notFoundMessage: 'No se encontró la persona solicitada.',
        });
      }
    },

    async updateDistribution({ actorUserId, householdId, input }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const access = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.ADMIN,
        });
        const requestedIds = input.people.map((person) => person.personId);
        const matchingPeople = await tx.householdPerson.findMany({
          where: {
            householdId,
            id: { in: requestedIds },
            archivedAt: null,
          },
          select: { id: true },
        });

        assertDomain(
          matchingPeople.length === requestedIds.length,
          404,
          'HOUSEHOLD_PERSON_NOT_FOUND',
          'Una o más personas no pertenecen a este hogar.',
        );

        for (const update of input.people) {
          const { personId, ...data } = update;
          await tx.householdPerson.update({
            where: { id: personId },
            data,
          });
        }

        const contributionMode =
          input.contributionMode ?? access.household.contributionMode;
        const people = await getDistributionPeople(tx, householdId);
        const totals = validateContributionDistribution(
          contributionMode,
          people,
        );

        if (input.contributionMode !== undefined) {
          await tx.household.update({
            where: { id: householdId },
            data: { contributionMode },
          });
        }

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'HOUSEHOLD_CHANGED',
          resourceType: 'HouseholdContributionDistribution',
          resourceId: householdId,
          metadata: {
            contributionMode,
            changedPersonCount: input.people.length,
          },
        });

        return { contributionMode, totals, people };
      });
    },

    async archive({ actorUserId, householdId, personId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const access = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.ADMIN,
        });
        await requireHouseholdPerson(tx, { householdId, personId });
        const activePersonalExpenses = await tx.recurringExpense.count({
          where: {
            householdId,
            personalPersonId: personId,
            scope: 'PERSONAL',
            isActive: true,
            archivedAt: null,
          },
        });

        assertDomain(
          activePersonalExpenses === 0,
          409,
          'HOUSEHOLD_PERSON_HAS_ACTIVE_EXPENSES',
          'Archiva o reasigna primero los gastos personales activos.',
          [{ activePersonalExpenses }],
        );

        const person = await tx.householdPerson.update({
          where: { id: personId },
          data: {
            isActive: false,
            archivedAt: new Date(),
            contributionBps: 0,
            fixedContributionCents: null,
          },
        });
        const people = await getDistributionPeople(tx, householdId);
        validateContributionDistribution(
          access.household.contributionMode,
          people,
        );

        await auditPersonChange(tx, {
          actorUserId,
          householdId,
          personId,
          operation: 'ARCHIVED',
        });

        return person;
      });
    },
  };
};
