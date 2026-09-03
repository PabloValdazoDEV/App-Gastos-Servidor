import { AppError } from '../errors/AppError.js';
import { createTokenService } from '../services/token.service.js';
import { parseCookies } from '../utils/cookies.js';

const unauthorized = () =>
  new AppError({
    statusCode: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Debes iniciar sesión para continuar.',
  });

const toPublicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  timezone: user.timezone,
  locale: user.locale,
});

export const createAuthenticate = ({ prisma, config }) => {
  const tokens = createTokenService(config);

  return async (request, _response, next) => {
    if (
      request.auth?.userId &&
      request.auth?.sessionId &&
      request.user?.id === request.auth.userId
    ) {
      next();
      return;
    }

    const accessToken = parseCookies(request.get('cookie'))[
      config.cookies.authName
    ];

    if (!accessToken) {
      next(unauthorized());
      return;
    }

    try {
      const payload = await tokens.verifyAccess(accessToken);

      if (typeof payload.sessionId !== 'string') {
        throw new Error('Session claim missing.');
      }

      const session = await prisma.refreshSession.findFirst({
        where: {
          id: payload.sessionId,
          userId: payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: { isActive: true },
        },
        include: { user: true },
      });

      if (!session) {
        next(unauthorized());
        return;
      }

      request.auth = { userId: session.userId, sessionId: session.id };
      request.user = toPublicUser(session.user);
      next();
    } catch {
      next(unauthorized());
    }
  };
};

export { toPublicUser };
