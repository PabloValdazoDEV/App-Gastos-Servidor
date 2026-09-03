import { AppError } from '../errors/AppError.js';
import { PRIVACY_POLICY_ERROR_CODES } from '../services/privacyPolicy.service.js';
import {
  authCookieOptions,
  clearAuthCookies,
  parseCookies,
  temporaryCookieOptions,
} from '../utils/cookies.js';
import { sendSuccess } from '../utils/httpResponses.js';

const requestContext = (request) => ({
  ipAddress: request.ip,
  userAgent: request.get('user-agent'),
});

const setSessionCookies = (response, config, authService, session) => {
  response.cookie(
    config.cookies.authName,
    session.accessToken,
    authCookieOptions(config, authService.tokens.accessMaxAgeMs),
  );
  response.cookie(
    config.cookies.refreshName,
    session.refreshToken,
    authCookieOptions(config, authService.tokens.refreshMaxAgeMs),
  );
};

const clearTemporaryCookie = (response, config, name, path) => {
  const options = temporaryCookieOptions(config, path);
  response.clearCookie(name, options);
};

const googleCallbackErrorCodes = new Set(
  Object.values(PRIVACY_POLICY_ERROR_CODES),
);

export const createAuthController = ({
  config,
  authService,
  googleAuthService,
  logger,
}) => ({
  register: async (request, response) => {
    const result = await authService.register(
      request.body,
      requestContext(request),
    );
    setSessionCookies(response, config, authService, result.session);
    return sendSuccess(response, { user: result.user }, { statusCode: 201 });
  },

  login: async (request, response) => {
    const result = await authService.login(request.body, requestContext(request));
    setSessionCookies(response, config, authService, result.session);
    return sendSuccess(response, { user: result.user });
  },

  refresh: async (request, response, next) => {
    const refreshToken = parseCookies(request.get('cookie'))[
      config.cookies.refreshName
    ];

    if (!refreshToken) {
      clearAuthCookies(response, config);
      next(
        new AppError({
          statusCode: 401,
          code: 'REFRESH_TOKEN_REQUIRED',
          message: 'La sesión ha caducado. Vuelve a iniciar sesión.',
        }),
      );
      return;
    }

    try {
      const result = await authService.refresh(
        refreshToken,
        requestContext(request),
      );
      setSessionCookies(response, config, authService, result.session);
      return sendSuccess(response, { user: result.user });
    } catch (error) {
      clearAuthCookies(response, config);
      next(error);
    }
  },

  logout: async (request, response) => {
    await authService.logout(request.auth, requestContext(request));
    clearAuthCookies(response, config);
    return sendSuccess(response, { loggedOut: true });
  },

  logoutAll: async (request, response) => {
    await authService.logoutAll(request.auth.userId, requestContext(request));
    clearAuthCookies(response, config);
    return sendSuccess(response, { loggedOut: true });
  },

  me: (request, response) => sendSuccess(response, { user: request.user }),

  sessions: async (request, response) => {
    const sessions = await authService.listSessions(request.auth);
    return sendSuccess(response, { sessions });
  },

  revokeSession: async (request, response) => {
    const result = await authService.revokeSession({
      userId: request.auth.userId,
      currentSessionId: request.auth.sessionId,
      targetSessionId: request.params.sessionId,
    });

    if (result.revokedCurrentSession) clearAuthCookies(response, config);
    return sendSuccess(response, { revoked: true });
  },

  forgotPassword: async (request, response) => {
    const result = await authService.forgotPassword(
      request.body.email,
      requestContext(request),
    );
    return sendSuccess(response, result);
  },

  resetPassword: async (request, response) => {
    const result = await authService.resetPassword(
      request.body,
      requestContext(request),
    );
    clearAuthCookies(response, config);
    return sendSuccess(response, result);
  },

  googleStart: async (request, response, next) => {
    try {
      const result = await googleAuthService.start(request.query);
      response.cookie(
        googleAuthService.oauthCookieName,
        result.oauthCookie,
        temporaryCookieOptions(
          config,
          '/api/auth/google',
          googleAuthService.temporaryMaxAgeMs,
        ),
      );
      return response.redirect(302, result.authorizationUrl);
    } catch (error) {
      if (googleCallbackErrorCodes.has(error?.code)) {
        const registerUrl = new URL('/register', config.app.clientUrl);
        registerUrl.searchParams.set('privacyError', error.code);
        return response.redirect(302, registerUrl.toString());
      }

      next(error);
      return undefined;
    }
  },

  googleCallback: async (request, response) => {
    const callbackUrl = new URL('/auth/callback', config.app.clientUrl);
    const cookies = parseCookies(request.get('cookie'));

    try {
      if (request.query.error) throw new Error('Provider rejected authorization.');

      const result = await googleAuthService.callback({
        ...request.query,
        oauthCookie: cookies[googleAuthService.oauthCookieName],
        accessToken: cookies[config.cookies.authName],
        requestContext: requestContext(request),
      });

      clearTemporaryCookie(
        response,
        config,
        googleAuthService.oauthCookieName,
        '/api/auth/google',
      );

      if (result.kind === 'link_required') {
        response.cookie(
          googleAuthService.linkCookieName,
          result.linkCookie,
          temporaryCookieOptions(
            config,
            '/api/auth/google',
            googleAuthService.temporaryMaxAgeMs,
          ),
        );
        callbackUrl.pathname = '/auth/google/link';
        callbackUrl.searchParams.set('status', 'link_required');
      } else {
        setSessionCookies(response, config, authService, result.session);
        callbackUrl.searchParams.set('status', 'success');
      }
    } catch (error) {
      clearTemporaryCookie(
        response,
        config,
        googleAuthService.oauthCookieName,
        '/api/auth/google',
      );
      logger.warn('auth.google.callback.failed', {
        errorName: error?.name ?? 'Error',
      });
      callbackUrl.searchParams.set('status', 'error');
      callbackUrl.searchParams.set(
        'error',
        googleCallbackErrorCodes.has(error?.code)
          ? error.code
          : 'GOOGLE_AUTH_FAILED',
      );
    }

    return response.redirect(302, callbackUrl.toString());
  },

  googleLinkConfirm: async (request, response) => {
    const cookies = parseCookies(request.get('cookie'));
    const result = await googleAuthService.confirmLink({
      linkCookie: cookies[googleAuthService.linkCookieName],
      password: request.body.password,
      suppliedEmail: request.body.email,
      requestContext: requestContext(request),
    });

    clearTemporaryCookie(
      response,
      config,
      googleAuthService.linkCookieName,
      '/api/auth/google',
    );
    setSessionCookies(response, config, authService, result.session);
    return sendSuccess(response, { user: result.user });
  },
});
