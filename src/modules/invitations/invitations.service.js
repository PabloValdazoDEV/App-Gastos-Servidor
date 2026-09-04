import { createHash, randomBytes } from 'node:crypto';

import { createAuditLog } from '../household-domain/audit.js';
import {
  assertDomain,
  createDomainError,
} from '../household-domain/domainError.js';
import { throwMappedPrismaError } from '../household-domain/prismaErrors.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import {
  HOUSEHOLD_ROLES,
  hasMinimumRole,
  requireHouseholdPerson,
  requireHouseholdRole,
} from '../households/authorization.js';

const INVITATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
});

export const generateInvitationToken = () => randomBytes(32).toString('base64url');

export const hashInvitationToken = (token) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const maskInvitationEmail = (email) => {
  if (!email) return null;
  const [localPart, domain] = email.split('@');
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}${'*'.repeat(Math.max(1, localPart.length - visible.length))}@${domain}`;
};

const expirationFrom = (date, ttlDays) =>
  new Date(date.getTime() + ttlDays * 24 * 60 * 60 * 1000);

const assertInvitationCanBeManaged = (actorRole, invitationRole) => {
  if (
    invitationRole === HOUSEHOLD_ROLES.ADMIN &&
    actorRole !== HOUSEHOLD_ROLES.OWNER
  ) {
    throw createDomainError(
      403,
      'HOUSEHOLD_PERMISSION_DENIED',
      'Solo el propietario puede gestionar invitaciones de administrador.',
    );
  }
};

const resolveAcceptedRole = (existingRole, invitationRole) => {
  if (!existingRole) return invitationRole;
  return hasMinimumRole(existingRole, invitationRole)
    ? existingRole
    : invitationRole;
};

const assertInvitationPending = async (database, invitation, currentDate) => {
  if (!invitation) {
    throw createDomainError(
      404,
      'INVITATION_NOT_FOUND',
      'La invitación no existe o el enlace no es válido.',
    );
  }

  if (
    invitation.status === INVITATION_STATUS.PENDING &&
    invitation.expiresAt <= currentDate
  ) {
    await database.invitation.updateMany({
      where: { id: invitation.id, status: INVITATION_STATUS.PENDING },
      data: { status: INVITATION_STATUS.EXPIRED },
    });
    throw createDomainError(
      410,
      'INVITATION_EXPIRED',
      'La invitación ha caducado.',
    );
  }

  assertDomain(
    invitation.status === INVITATION_STATUS.PENDING,
    409,
    'INVITATION_NOT_PENDING',
    'La invitación ya no está disponible.',
  );
};

export const createInvitationsService = ({
  prisma,
  invitationTtlDays = 7,
  now = () => new Date(),
  tokenFactory = generateInvitationToken,
  emailService,
  logger,
}) => {
  if (!prisma) {
    throw new TypeError('createInvitationsService requires prisma.');
  }

  return {
    async list({ actorUserId, householdId }) {
      await requireHouseholdRole(prisma, {
        householdId,
        userId: actorUserId,
        minimumRole: HOUSEHOLD_ROLES.ADMIN,
      });

      return prisma.invitation.findMany({
        where: { householdId },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          createdAt: true,
          householdPerson: {
            select: { id: true, name: true, email: true },
          },
          invitedBy: { select: { id: true, name: true } },
          acceptedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    },

    async create({ actorUserId, householdId, input }) {
      const rawToken = tokenFactory();
      const tokenHash = hashInvitationToken(rawToken);
      const currentDate = now();
      const expiresAt = expirationFrom(currentDate, invitationTtlDays);

      try {
        const result = await runSerializableTransaction(
          prisma,
          async (tx) => {
            const access = await requireHouseholdRole(tx, {
              householdId,
              userId: actorUserId,
              minimumRole: HOUSEHOLD_ROLES.ADMIN,
            });
            assertInvitationCanBeManaged(access.role, input.role);

            const person = input.householdPersonId
              ? await requireHouseholdPerson(tx, {
                  householdId,
                  personId: input.householdPersonId,
                })
              : null;
            assertDomain(
              !person?.linkedUserId,
              409,
              'HOUSEHOLD_PERSON_ALREADY_LINKED',
              'La persona ya está vinculada a un usuario.',
            );
            assertDomain(
              !input.email ||
                !person?.email ||
                input.email === person.email.toLowerCase(),
              409,
              'INVITATION_EMAIL_MISMATCH',
              'El correo no coincide con el de la persona del hogar.',
            );

            const email = input.email ?? person?.email ?? null;
            await tx.invitation.updateMany({
              where: {
                householdId,
                status: INVITATION_STATUS.PENDING,
                expiresAt: { lte: currentDate },
              },
              data: { status: INVITATION_STATUS.EXPIRED },
            });

            const pendingTargets = [];
            if (email) pendingTargets.push({ email });
            if (person) {
              pendingTargets.push({ householdPersonId: person.id });
            }
            const pending = await tx.invitation.findFirst({
              where: {
                householdId,
                status: INVITATION_STATUS.PENDING,
                OR: pendingTargets,
              },
              select: { id: true },
            });
            assertDomain(
              !pending,
              409,
              'INVITATION_ALREADY_PENDING',
              'Ya existe una invitación pendiente para ese destino.',
            );

            if (email) {
              const invitedUser = await tx.user.findUnique({
                where: { email },
                select: { id: true },
              });
              if (invitedUser) {
                const existingAccess = await tx.householdUserAccess.findUnique({
                  where: {
                    householdId_userId: {
                      householdId,
                      userId: invitedUser.id,
                    },
                  },
                  select: { isActive: true, revokedAt: true },
                });
                assertDomain(
                  !existingAccess?.isActive || existingAccess.revokedAt !== null,
                  409,
                  'USER_ALREADY_HAS_HOUSEHOLD_ACCESS',
                  'Ese usuario ya tiene acceso al hogar.',
                );
              }
            }

            const created = await tx.invitation.create({
              data: {
                householdId,
                householdPersonId: person?.id ?? null,
                invitedByUserId: actorUserId,
                email,
                role: input.role,
                tokenHash,
                expiresAt,
              },
              select: {
                id: true,
                householdId: true,
                householdPersonId: true,
                email: true,
                role: true,
                status: true,
                expiresAt: true,
                createdAt: true,
              },
            });

            await createAuditLog(tx, {
              actorUserId,
              householdId,
              action: 'INVITATION_CREATED',
              resourceType: 'Invitation',
              resourceId: created.id,
              metadata: {
                role: created.role,
                hasEmail: created.email !== null,
                hasHouseholdPerson: created.householdPersonId !== null,
              },
            });

            return {
              invitation: created,
              householdName: access.household.name,
            };
          },
        );

        let emailSent = false;
        if (
          result.invitation.email &&
          emailService?.enabled &&
          typeof emailService.sendInvitation === 'function'
        ) {
          try {
            emailSent = await emailService.sendInvitation({
              householdName: result.householdName,
              recipient: result.invitation.email,
              role: result.invitation.role,
              token: rawToken,
            });
          } catch (error) {
            logger?.error('email.invitation.failed', {
              errorName: error?.name ?? 'Error',
            });
          }
        }

        return { invitation: result.invitation, token: rawToken, emailSent };
      } catch (error) {
        throwMappedPrismaError(error, {
          uniqueCode: 'INVITATION_ALREADY_PENDING',
          uniqueMessage: 'Ya existe una invitación pendiente para ese destino.',
        });
      }
    },

    async preview({ token }) {
      const currentDate = now();
      const tokenHash = hashInvitationToken(token);
      const invitation = await prisma.invitation.findUnique({
        where: { tokenHash },
        include: {
          household: { select: { id: true, name: true } },
          householdPerson: { select: { id: true, name: true } },
          invitedBy: { select: { name: true } },
        },
      });
      await assertInvitationPending(prisma, invitation, currentDate);

      return {
        household: invitation.household,
        householdPerson: invitation.householdPerson,
        role: invitation.role,
        emailHint: maskInvitationEmail(invitation.email),
        invitedByName: invitation.invitedBy.name,
        expiresAt: invitation.expiresAt,
      };
    },

    async accept({ actorUserId, token }) {
      const currentDate = now();
      const tokenHash = hashInvitationToken(token);

      return runSerializableTransaction(prisma, async (tx) => {
        const invitation = await tx.invitation.findUnique({
          where: { tokenHash },
          include: {
            household: {
              select: {
                id: true,
                name: true,
                isActive: true,
                ownerUserId: true,
              },
            },
            householdPerson: true,
          },
        });
        await assertInvitationPending(tx, invitation, currentDate);
        assertDomain(
          invitation.household.isActive,
          409,
          'HOUSEHOLD_ARCHIVED',
          'No se puede aceptar una invitación de un hogar archivado.',
        );

        const user = await tx.user.findUnique({
          where: { id: actorUserId },
          select: { id: true, email: true, isActive: true },
        });
        assertDomain(
          user?.isActive,
          401,
          'AUTHENTICATION_REQUIRED',
          'Necesitas una cuenta activa para aceptar la invitación.',
        );
        assertDomain(
          !invitation.email ||
            invitation.email.toLowerCase() === user.email.toLowerCase(),
          403,
          'INVITATION_EMAIL_MISMATCH',
          'La invitación está destinada a otra dirección de correo.',
        );

        const person = invitation.householdPerson;
        assertDomain(
          !person ||
            (person.householdId === invitation.householdId &&
              person.archivedAt === null),
          409,
          'INVITATION_PERSON_UNAVAILABLE',
          'La persona vinculada a la invitación ya no está disponible.',
        );
        assertDomain(
          !person?.linkedUserId || person.linkedUserId === actorUserId,
          409,
          'HOUSEHOLD_PERSON_ALREADY_LINKED',
          'La persona ya está vinculada a otro usuario.',
        );

        if (person) {
          const otherLinkedPerson = await tx.householdPerson.findFirst({
            where: {
              householdId: invitation.householdId,
              linkedUserId: actorUserId,
              id: { not: person.id },
            },
            select: { id: true },
          });
          assertDomain(
            !otherLinkedPerson,
            409,
            'USER_ALREADY_LINKED_TO_HOUSEHOLD_PERSON',
            'Tu usuario ya está vinculado a otra persona de este hogar.',
          );
        }

        const existingAccess = await tx.householdUserAccess.findUnique({
          where: {
            householdId_userId: {
              householdId: invitation.householdId,
              userId: actorUserId,
            },
          },
        });
        const existingRole =
          existingAccess?.role === HOUSEHOLD_ROLES.OWNER &&
          invitation.household.ownerUserId !== actorUserId
            ? null
            : existingAccess?.role;
        const role = resolveAcceptedRole(existingRole, invitation.role);
        const claimed = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            status: INVITATION_STATUS.PENDING,
            expiresAt: { gt: currentDate },
          },
          data: {
            status: INVITATION_STATUS.ACCEPTED,
            acceptedByUserId: actorUserId,
            acceptedAt: currentDate,
          },
        });
        assertDomain(
          claimed.count === 1,
          409,
          'INVITATION_ACCEPT_CONFLICT',
          'La invitación se utilizó mientras se procesaba la solicitud.',
        );

        const access = await tx.householdUserAccess.upsert({
          where: {
            householdId_userId: {
              householdId: invitation.householdId,
              userId: actorUserId,
            },
          },
          update: { role, isActive: true, revokedAt: null },
          create: {
            householdId: invitation.householdId,
            userId: actorUserId,
            role,
          },
        });

        if (person && person.linkedUserId !== actorUserId) {
          const linked = await tx.householdPerson.updateMany({
            where: {
              id: person.id,
              householdId: invitation.householdId,
              archivedAt: null,
              linkedUserId: null,
            },
            data: { linkedUserId: actorUserId },
          });
          assertDomain(
            linked.count === 1,
            409,
            'HOUSEHOLD_PERSON_LINK_CONFLICT',
            'La persona se vinculó a otra cuenta durante la operación.',
          );
        }

        await createAuditLog(tx, {
          actorUserId,
          householdId: invitation.householdId,
          action: 'MEMBER_LINKED',
          resourceType: person ? 'HouseholdPerson' : 'HouseholdUserAccess',
          resourceId: person?.id ?? access.id,
          metadata: {
            role,
            linkedHouseholdPerson: Boolean(person),
            invitationId: invitation.id,
          },
        });

        return {
          household: invitation.household,
          access: { id: access.id, role: access.role },
          householdPersonId: person?.id ?? null,
        };
      });
    },

    async revoke({ actorUserId, householdId, invitationId }) {
      return runSerializableTransaction(prisma, async (tx) => {
        const access = await requireHouseholdRole(tx, {
          householdId,
          userId: actorUserId,
          minimumRole: HOUSEHOLD_ROLES.ADMIN,
        });
        const invitation = await tx.invitation.findFirst({
          where: { id: invitationId, householdId },
        });
        assertDomain(
          invitation,
          404,
          'INVITATION_NOT_FOUND',
          'No se encontró la invitación solicitada en este hogar.',
        );
        assertInvitationCanBeManaged(access.role, invitation.role);
        await assertInvitationPending(tx, invitation, now());

        const revokedAt = now();
        const revoked = await tx.invitation.update({
          where: { id: invitationId },
          data: {
            status: INVITATION_STATUS.REVOKED,
            revokedAt,
          },
          select: {
            id: true,
            role: true,
            status: true,
            revokedAt: true,
          },
        });

        await createAuditLog(tx, {
          actorUserId,
          householdId,
          action: 'INVITATION_REVOKED',
          resourceType: 'Invitation',
          resourceId: invitationId,
          metadata: { role: invitation.role },
        });

        return revoked;
      });
    },
  };
};
