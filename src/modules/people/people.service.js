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
import { businessToday } from '../../services/businessClock.service.js';
import { startOfMonth } from '../../services/date.service.js';

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

const plural = (count, singular, pluralForm) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

// Inactive/archived people are dropped from every contribution, while their
// PERSONAL lines would stay in the budget totals. Block the change until those
// obligations are reassigned or finished. One count per source, all indexed by
// personalPersonId/householdId, run in parallel inside the same transaction.
export const findPendingPersonalObligations = async (
  database,
  { householdId, personId, today },
) => {
  const monthStart = startOfMonth(today);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth() + 1;
  const personal = { householdId, scope: 'PERSONAL', personalPersonId: personId };
  const [
    recurringExpenses,
    purchasesWithPendingPayments,
    oneTimeExpenses,
    variableExpenseMonths,
    utilityInvoices,
  ] = await Promise.all([
    database.recurringExpense.count({
      where: { ...personal, isActive: true, archivedAt: null },
    }),
    database.purchase.count({
      where: {
        householdId,
        archivedAt: null,
        paymentMethod: 'FINANCED',
        AND: [
          {
            OR: [
              { ownershipType: 'PERSONAL', personalPersonId: personId },
              { ownershipType: 'SPLIT', shares: { some: { householdPersonId: personId } } },
            ],
          },
          {
            OR: [
              { financing: { installments: { some: { status: 'PLANNED' } } } },
              { financing: { downPaymentCents: { gt: 0 }, downPaymentPaidAt: null } },
            ],
          },
        ],
      },
    }),
    database.oneTimeExpense.count({
      where: { ...personal, expenseDate: { gte: today } },
    }),
    database.variableExpenseMonth.count({
      where: {
        ...personal,
        OR: [{ year: { gt: year } }, { year, month: { gte: month } }],
      },
    }),
    database.utilityInvoice.count({
      where: {
        ...personal,
        OR: [{ periodEnd: { gte: monthStart } }, { chargeDate: { gte: monthStart } }],
      },
    }),
  ]);

  return {
    recurringExpenses,
    purchasesWithPendingPayments,
    oneTimeExpenses,
    variableExpenseMonths,
    utilityInvoices,
  };
};

const assertNoPendingPersonalObligations = async (
  database,
  { household, person, action },
) => {
  const pending = await findPendingPersonalObligations(database, {
    householdId: household.id,
    personId: person.id,
    today: businessToday(household.timezone ?? undefined),
  });
  const parts = [
    pending.recurringExpenses &&
      plural(pending.recurringExpenses, 'gasto recurrente activo', 'gastos recurrentes activos'),
    pending.purchasesWithPendingPayments &&
      plural(pending.purchasesWithPendingPayments, 'compra con pagos pendientes', 'compras con pagos pendientes'),
    pending.oneTimeExpenses &&
      plural(pending.oneTimeExpenses, 'gasto puntual de hoy o posterior', 'gastos puntuales de hoy o posteriores'),
    pending.variableExpenseMonths &&
      plural(pending.variableExpenseMonths, 'mes de gasto variable actual o futuro', 'meses de gasto variable actuales o futuros'),
    pending.utilityInvoices &&
      plural(pending.utilityInvoices, 'factura del mes actual o posterior', 'facturas del mes actual o posteriores'),
  ].filter(Boolean);

  assertDomain(
    parts.length === 0,
    409,
    'HOUSEHOLD_PERSON_HAS_ACTIVE_EXPENSES',
    `No se puede ${action} a ${person.name}: todavía tiene a su nombre ${parts.join(', ')}. ` +
      'Reasígnalos al hogar o a otra persona, o finalízalos o elimínalos antes; si no, ' +
      'seguirían sumando al presupuesto sin que nadie los aporte.',
    [{ activePersonalExpenses: pending.recurringExpenses, ...pending }],
  );
};

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
          const current = await requireHouseholdPerson(tx, { householdId, personId });
          if (input.isActive === false && current.isActive) {
            await assertNoPendingPersonalObligations(tx, {
              household: access.household,
              person: current,
              action: 'desactivar',
            });
          }
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
          select: { id: true, name: true, isActive: true },
        });

        assertDomain(
          matchingPeople.length === requestedIds.length,
          404,
          'HOUSEHOLD_PERSON_NOT_FOUND',
          'Una o más personas no pertenecen a este hogar.',
        );

        const currentById = new Map(matchingPeople.map((person) => [person.id, person]));
        for (const update of input.people) {
          const current = currentById.get(update.personId);
          if (update.isActive === false && current?.isActive) {
            await assertNoPendingPersonalObligations(tx, {
              household: access.household,
              person: current,
              action: 'desactivar',
            });
          }
        }

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
        const current = await requireHouseholdPerson(tx, { householdId, personId });
        await assertNoPendingPersonalObligations(tx, {
          household: access.household,
          person: current,
          action: 'archivar',
        });

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
