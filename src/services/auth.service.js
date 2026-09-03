import { randomUUID } from 'node:crypto';

import { AppError } from '../errors/AppError.js';
import { toPublicUser } from '../middleware/authenticate.js';
import { hashNetworkIdentifier, randomToken, sha256 } from '../utils/crypto.js';
import { hashPassword, verifyPassword } from './password.service.js';
import {
  recordRegistrationPrivacyAcceptance,
  resolveRegistrationPrivacyPolicy,
} from './privacyPolicy.service.js';
import { createTokenService } from './token.service.js';

const INVALID_CREDENTIALS = Object.freeze({
  statusCode: 401,
  code: 'INVALID_CREDENTIALS',
  message: 'El correo o la contraseña no son correctos.',
});

const INVALID_REFRESH = Object.freeze({
  statusCode: 401,
  code: 'REFRESH_TOKEN_INVALID',
  message: 'La sesión ha caducado. Vuelve a iniciar sesión.',
});

const INVALID_RESET = Object.freeze({
  statusCode: 400,
  code: 'PASSWORD_RESET_TOKEN_INVALID',
  message: 'El enlace de recuperación no es válido o ha caducado.',
});

const genericForgotMessage =
  'Si existe una cuenta asociada al correo, recibirás las instrucciones.';

const safeUserAgent = (value) => {
  if (!value) return null;

  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .slice(0, 512);
};

const isUniqueConstraintError = (error) => error?.code === 'P2002';

export const createAuthService = ({ prisma, config, emailService, logger }) => {
  const tokens = createTokenService(config);
  const dummyHash = hashPassword('Invalid-password-1!', config.bcrypt.rounds);

  const sessionContext = (requestContext) => ({
    ipAddressHash: hashNetworkIdentifier(
      requestContext.ipAddress,
      config.csrf.secret,
    ),
    userAgent: safeUserAgent(requestContext.userAgent),
  });

  const issueSession = async ({ user, requestContext, tx = prisma, familyId }) => {
    const id = randomUUID();
    const resolvedFamilyId = familyId ?? randomUUID();
    const refreshToken = await tokens.signRefresh({
      userId: user.id,
      sessionId: id,
      familyId: resolvedFamilyId,
    });
    const expiresAt = new Date(Date.now() + tokens.refreshMaxAgeMs);

    await tx.refreshSession.create({
      data: {
        id,
        userId: user.id,
        tokenHash: sha256(refreshToken),
        familyId: resolvedFamilyId,
        expiresAt,
        ...sessionContext(requestContext),
      },
    });

    const accessToken = await tokens.signAccess({
      userId: user.id,
      sessionId: id,
    });

    return { id, accessToken, refreshToken, expiresAt };
  };

  const createAudit = (tx, { userId, action, requestContext, metadata }) =>
    tx.auditLog.create({
      data: {
        actorUserId: userId,
        action,
        resourceType: 'User',
        resourceId: userId,
        metadata,
        ipAddressHash: hashNetworkIdentifier(
          requestContext.ipAddress,
          config.csrf.secret,
        ),
      },
    });

  return Object.freeze({
    tokens,

    async register(
      {
        name,
        email,
        password,
        privacyPolicyAcknowledged,
        privacyPolicyVersion,
      },
      requestContext,
    ) {
      const documentVersion = resolveRegistrationPrivacyPolicy({
        config,
        privacyPolicyAcknowledged,
        privacyPolicyVersion,
      });
      const passwordHash = await hashPassword(password, config.bcrypt.rounds);

      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              name,
              email,
              passwordHash,
              timezone: config.defaults.timezone,
              locale: config.defaults.locale,
            },
          });
          await recordRegistrationPrivacyAcceptance({
            tx,
            userId: user.id,
            documentVersion,
          });
          const session = await issueSession({ user, requestContext, tx });

          await createAudit(tx, {
            userId: user.id,
            action: 'REGISTER',
            requestContext,
          });

          return { user: toPublicUser(user), session };
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AppError({
            statusCode: 409,
            code: 'EMAIL_ALREADY_REGISTERED',
            message: 'Ya existe una cuenta con ese correo electrónico.',
          });
        }

        throw error;
      }
    },

    async login({ email, password }, requestContext) {
      const user = await prisma.user.findUnique({ where: { email } });
      const passwordMatches = user?.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : await verifyPassword(password, await dummyHash);

      if (!user || !passwordMatches || !user.isActive) {
        throw new AppError(INVALID_CREDENTIALS);
      }

      return prisma.$transaction(async (tx) => {
        const session = await issueSession({ user, requestContext, tx });

        await createAudit(tx, {
          userId: user.id,
          action: 'LOGIN',
          requestContext,
        });

        return { user: toPublicUser(user), session };
      });
    },

    async refresh(refreshToken, requestContext) {
      let payload;

      try {
        payload = await tokens.verifyRefresh(refreshToken);
      } catch {
        throw new AppError(INVALID_REFRESH);
      }

      if (
        typeof payload.sessionId !== 'string' ||
        typeof payload.familyId !== 'string'
      ) {
        throw new AppError(INVALID_REFRESH);
      }

      const presentedHash = sha256(refreshToken);
      const newSessionId = randomUUID();
      const newRefreshToken = await tokens.signRefresh({
        userId: payload.sub,
        sessionId: newSessionId,
        familyId: payload.familyId,
      });
      const now = new Date();
      const expiresAt = new Date(Date.now() + tokens.refreshMaxAgeMs);

      const result = await prisma.$transaction(async (tx) => {
          const current = await tx.refreshSession.findUnique({
            where: { id: payload.sessionId },
            include: { user: true },
          });

          const compromised =
            !current ||
            current.userId !== payload.sub ||
            current.familyId !== payload.familyId ||
            current.tokenHash !== presentedHash ||
            current.revokedAt !== null ||
            current.expiresAt <= now ||
            !current.user.isActive;

          if (compromised) {
            if (current?.familyId) {
              await tx.refreshSession.updateMany({
                where: { familyId: current.familyId, revokedAt: null },
                data: {
                  revokedAt: now,
                  revocationReason: 'TOKEN_REUSE_DETECTED',
                },
              });
            }

            return { invalid: true };
          }

          const rotation = await tx.refreshSession.updateMany({
            where: { id: current.id, revokedAt: null },
            data: {
              revokedAt: now,
              revocationReason: 'ROTATED',
              lastUsedAt: now,
            },
          });

          if (rotation.count !== 1) {
            await tx.refreshSession.updateMany({
              where: { familyId: current.familyId, revokedAt: null },
              data: {
                revokedAt: now,
                revocationReason: 'TOKEN_REUSE_DETECTED',
              },
            });
            return { invalid: true };
          }

          await tx.refreshSession.create({
            data: {
              id: newSessionId,
              userId: current.userId,
              tokenHash: sha256(newRefreshToken),
              familyId: current.familyId,
              rotatedFromSessionId: current.id,
              expiresAt,
              ...sessionContext(requestContext),
            },
          });

          return { user: current.user };
        });

      if (result.invalid) {
        logger.warn('auth.refresh.reuse_or_invalid_session', {
          sessionId: payload.sessionId,
        });
        throw new AppError(INVALID_REFRESH);
      }

      const accessToken = await tokens.signAccess({
        userId: result.user.id,
        sessionId: newSessionId,
      });

      return {
        user: toPublicUser(result.user),
        session: {
          id: newSessionId,
          accessToken,
          refreshToken: newRefreshToken,
          expiresAt,
        },
      };
    },

    async logout({ userId, sessionId }, requestContext) {
      await prisma.$transaction(async (tx) => {
        await tx.refreshSession.updateMany({
          where: { id: sessionId, userId, revokedAt: null },
          data: { revokedAt: new Date(), revocationReason: 'LOGOUT' },
        });
        await createAudit(tx, {
          userId,
          action: 'LOGOUT',
          requestContext,
          metadata: { scope: 'current_session' },
        });
      });
    },

    async logoutAll(userId, requestContext) {
      await prisma.$transaction(async (tx) => {
        await tx.refreshSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revocationReason: 'LOGOUT_ALL' },
        });
        await createAudit(tx, {
          userId,
          action: 'LOGOUT',
          requestContext,
          metadata: { scope: 'all_sessions' },
        });
      });
    },

    async listSessions({ userId, sessionId }) {
      const sessions = await prisma.refreshSession.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          userAgent: true,
        },
      });

      return sessions.map((session) => ({
        ...session,
        current: session.id === sessionId,
      }));
    },

    async revokeSession({ userId, currentSessionId, targetSessionId }) {
      const result = await prisma.refreshSession.updateMany({
        where: { id: targetSessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: 'USER_REVOKED' },
      });

      if (result.count === 0) {
        throw new AppError({
          statusCode: 404,
          code: 'SESSION_NOT_FOUND',
          message: 'No se encontró la sesión solicitada.',
        });
      }

      return { revokedCurrentSession: targetSessionId === currentSessionId };
    },

    async forgotPassword(email, requestContext) {
      const user = await prisma.user.findUnique({ where: { email } });

      if (!user?.isActive || !user.passwordHash) {
        await dummyHash;
        return { message: genericForgotMessage };
      }

      const token = randomToken(48);
      const now = new Date();
      const expiresAt = new Date(
        Date.now() + config.tokens.passwordResetTtlMinutes * 60_000,
      );

      await prisma.$transaction(async (tx) => {
        await tx.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256(token),
            expiresAt,
            requestedIpHash: hashNetworkIdentifier(
              requestContext.ipAddress,
              config.csrf.secret,
            ),
          },
        });
      });

      try {
        await emailService.sendPasswordReset({
          recipient: user.email,
          name: user.name,
          token,
        });
      } catch (error) {
        logger.error('email.password_reset.failed', {
          errorName: error?.name ?? 'Error',
        });
      }

      return { message: genericForgotMessage };
    },

    async resetPassword({ token, password }, requestContext) {
      const passwordHash = await hashPassword(password, config.bcrypt.rounds);
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const resetToken = await tx.passwordResetToken.findUnique({
          where: { tokenHash: sha256(token) },
        });

        if (
          !resetToken ||
          resetToken.usedAt ||
          resetToken.revokedAt ||
          resetToken.expiresAt <= now
        ) {
          throw new AppError(INVALID_RESET);
        }

        const consumed = await tx.passwordResetToken.updateMany({
          where: { id: resetToken.id, usedAt: null, revokedAt: null },
          data: { usedAt: now },
        });

        if (consumed.count !== 1) {
          throw new AppError(INVALID_RESET);
        }

        await tx.user.update({
          where: { id: resetToken.userId },
          data: { passwordHash },
        });
        await tx.passwordResetToken.updateMany({
          where: {
            userId: resetToken.userId,
            id: { not: resetToken.id },
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        await tx.refreshSession.updateMany({
          where: { userId: resetToken.userId, revokedAt: null },
          data: { revokedAt: now, revocationReason: 'PASSWORD_CHANGED' },
        });
        await createAudit(tx, {
          userId: resetToken.userId,
          action: 'PASSWORD_CHANGED',
          requestContext,
        });

        return { passwordReset: true };
      });
    },

    issueSession,
  });
};

export { genericForgotMessage };
