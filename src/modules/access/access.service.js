import { createAuditLog } from '../household-domain/audit.js';
import { assertDomain } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  HOUSEHOLD_ROLES,
  requireHouseholdAccessRecord,
  requireHouseholdRole,
} from '../households/authorization.js';

const assertMutableAccess = (access, household) => {
  assertDomain(
    access.role !== HOUSEHOLD_ROLES.OWNER &&
      access.userId !== household.ownerUserId,
    409,
    'OWNER_ACCESS_PROTECTED',
    'El acceso del propietario solo cambia mediante una transferencia.',
  );
};

export const createAccessService = ({ prisma }) => {
  if (!prisma) throw new TypeError('createAccessService requires prisma.');

  return {
    async list({ actorUserId, householdId }) {
      await requireHouseholdRole(prisma, {
        householdId,
        userId: actorUserId,
        minimumRole: HOUSEHOLD_ROLES.ADMIN,
      });

      return prisma.householdUserAccess.findMany({
        where: { householdId },
        select: {
          id: true,
          role: true,
          isActive: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              isActive: true,
            },
          },
        },
        orderBy: [
          { isActive: 'desc' },
          { role: 'asc' },
          { createdAt: 'asc' },
        ],
      });
    },

    async update({ actorUserId, householdId, accessId, role }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const ownerAccess = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.OWNER,
        });
        const targetAccess = await requireHouseholdAccessRecord(tx, {
          householdId,
          accessId,
        });
        assertMutableAccess(targetAccess, ownerAccess.household);
        assertDomain(
          targetAccess.isActive && targetAccess.revokedAt === null,
          409,
          'HOUSEHOLD_ACCESS_INACTIVE',
          'No se puede modificar un acceso revocado.',
        );

        const access = await tx.householdUserAccess.update({
          where: { id: accessId },
          data: { role },
          select: {
            id: true,
            role: true,
            isActive: true,
            revokedAt: true,
            updatedAt: true,
            user: { select: { id: true, name: true, email: true } },
          },
        });

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'ACCESS_CHANGED',
          resourceType: 'HouseholdUserAccess',
          resourceId: accessId,
          metadata: { operation: 'ROLE_CHANGED', role },
        });

        return access;
      });
    },

    async revoke({ actorUserId, householdId, accessId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const ownerAccess = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.OWNER,
        });
        const targetAccess = await requireHouseholdAccessRecord(tx, {
          householdId,
          accessId,
        });
        assertMutableAccess(targetAccess, ownerAccess.household);
        assertDomain(
          targetAccess.isActive && targetAccess.revokedAt === null,
          409,
          'HOUSEHOLD_ACCESS_ALREADY_REVOKED',
          'El acceso ya estaba revocado.',
        );

        const revokedAt = new Date();
        const access = await tx.householdUserAccess.update({
          where: { id: accessId },
          data: { isActive: false, revokedAt },
          select: {
            id: true,
            role: true,
            isActive: true,
            revokedAt: true,
            user: { select: { id: true, name: true, email: true } },
          },
        });

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'ACCESS_CHANGED',
          resourceType: 'HouseholdUserAccess',
          resourceId: accessId,
          metadata: { operation: 'REVOKED' },
        });

        return access;
      });
    },

    async transferOwnership({ actorUserId, householdId, newOwnerUserId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const currentOwnerAccess = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.OWNER,
        });
        assertDomain(
          newOwnerUserId !== actorUserId,
          409,
          'OWNERSHIP_ALREADY_ASSIGNED',
          'El usuario indicado ya es propietario del hogar.',
        );

        const targetAccess = await tx.householdUserAccess.findFirst({
          where: {
            householdId,
            userId: newOwnerUserId,
            isActive: true,
            revokedAt: null,
          },
          include: {
            user: { select: { id: true, name: true, isActive: true } },
          },
        });
        assertDomain(
          targetAccess?.user?.isActive,
          409,
          'NEW_OWNER_NEEDS_ACTIVE_ACCESS',
          'El nuevo propietario necesita un usuario y acceso activos en el hogar.',
        );

        const changedHousehold = await tx.household.updateMany({
          where: {
            id: householdId,
            ownerUserId: actorUserId,
            isActive: true,
          },
          data: { ownerUserId: newOwnerUserId },
        });
        assertDomain(
          changedHousehold.count === 1,
          409,
          'OWNERSHIP_TRANSFER_CONFLICT',
          'La propiedad cambió mientras se procesaba la solicitud.',
        );

        await tx.householdUserAccess.update({
          where: { id: currentOwnerAccess.id },
          data: { role: HOUSEHOLD_ROLES.ADMIN },
        });
        await tx.householdUserAccess.update({
          where: { id: targetAccess.id },
          data: { role: HOUSEHOLD_ROLES.OWNER },
        });

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'OWNERSHIP_TRANSFERRED',
          resourceType: 'Household',
          resourceId: householdId,
          metadata: { newOwnerUserId },
        });

        return {
          householdId,
          ownerUserId: newOwnerUserId,
          previousOwner: {
            userId: actorUserId,
            role: HOUSEHOLD_ROLES.ADMIN,
          },
          newOwner: {
            userId: newOwnerUserId,
            role: HOUSEHOLD_ROLES.OWNER,
          },
        };
      });
    },
  };
};
