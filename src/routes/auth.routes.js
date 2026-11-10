import { Router } from 'express';

import { createAuthController } from '../controllers/auth.controller.js';
import { createAuthenticate } from '../middleware/authenticate.js';
import {
  createCsrfProtection,
  createCsrfTokenHandler,
} from '../middleware/csrf.js';
import {
  createAuthAccountRateLimiter,
  createAuthRateLimiter,
  createAuthRefreshRateLimiter,
} from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { createAuthService } from '../services/auth.service.js';
import { createEmailService } from '../services/email.service.js';
import { createGoogleAuthService } from '../services/googleAuth.service.js';
import {
  forgotPasswordSchema,
  googleCallbackSchema,
  googleLinkSchema,
  googleStartSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  sessionParamsSchema,
} from '../validators/auth.validators.js';

export const createAuthRouter = ({
  prisma,
  config,
  logger,
  emailService: suppliedEmailService,
  authenticate: suppliedAuthenticate,
  requireCsrf: suppliedRequireCsrf,
}) => {
  const router = Router();
  const emailService =
    suppliedEmailService ?? createEmailService({ config, logger });
  const authService = createAuthService({
    prisma,
    config,
    emailService,
    logger,
  });
  const googleAuthService = createGoogleAuthService({
    prisma,
    config,
    authService,
  });
  const controller = createAuthController({
    config,
    authService,
    googleAuthService,
    logger,
  });
  const authenticate =
    suppliedAuthenticate ?? createAuthenticate({ prisma, config });
  const requireCsrf =
    suppliedRequireCsrf ?? createCsrfProtection({ config });
  const rateLimits =
    config.nodeEnv === 'development'
      ? { account: [], strict: [], refresh: [] }
      : {
          account: [createAuthAccountRateLimiter(config.rateLimit.auth)],
          strict: [createAuthRateLimiter(config.rateLimit.auth)],
          // Separate bucket: automatic refreshes from several tabs/devices on
          // the same IP must not exhaust the brute-force limiter (or vice versa).
          refresh: [createAuthRefreshRateLimiter(config.rateLimit.refresh)],
        };

  router.get('/csrf', createCsrfTokenHandler({ config }));
  router.post(
    '/register',
    ...rateLimits.strict,
    ...rateLimits.account,
    requireCsrf,
    validate({ body: registerSchema }),
    controller.register,
  );
  router.post(
    '/login',
    ...rateLimits.strict,
    ...rateLimits.account,
    requireCsrf,
    validate({ body: loginSchema }),
    controller.login,
  );
  router.post(
    '/refresh',
    ...rateLimits.refresh,
    requireCsrf,
    controller.refresh,
  );
  // No `authenticate`: logout must also work when the access token has already
  // expired. The controller revokes the session identified by the refresh
  // cookie and/or a still-valid access token and always clears the cookies.
  router.post('/logout', requireCsrf, controller.logout);
  router.post('/logout-all', requireCsrf, authenticate, controller.logoutAll);
  router.get('/me', authenticate, controller.me);
  router.get('/sessions', authenticate, controller.sessions);
  router.delete(
    '/sessions/:sessionId',
    requireCsrf,
    authenticate,
    validate({ params: sessionParamsSchema }),
    controller.revokeSession,
  );
  router.post(
    '/forgot-password',
    ...rateLimits.strict,
    ...rateLimits.account,
    requireCsrf,
    validate({ body: forgotPasswordSchema }),
    controller.forgotPassword,
  );
  router.post(
    '/reset-password',
    ...rateLimits.strict,
    requireCsrf,
    validate({ body: resetPasswordSchema }),
    controller.resetPassword,
  );
  router.get(
    '/google/start',
    ...rateLimits.strict,
    validate({ query: googleStartSchema }),
    controller.googleStart,
  );
  router.get(
    '/google/callback',
    ...rateLimits.strict,
    validate({ query: googleCallbackSchema }),
    controller.googleCallback,
  );
  router.post(
    '/google/link/confirm',
    ...rateLimits.strict,
    requireCsrf,
    validate({ body: googleLinkSchema }),
    controller.googleLinkConfirm,
  );

  return router;
};
