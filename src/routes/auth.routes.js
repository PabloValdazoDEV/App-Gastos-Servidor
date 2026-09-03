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
  const strictLimit = createAuthRateLimiter(config.rateLimit.auth);
  const accountLimit = createAuthAccountRateLimiter(config.rateLimit.auth);

  router.get('/csrf', createCsrfTokenHandler({ config }));
  router.post(
    '/register',
    strictLimit,
    accountLimit,
    requireCsrf,
    validate({ body: registerSchema }),
    controller.register,
  );
  router.post(
    '/login',
    strictLimit,
    accountLimit,
    requireCsrf,
    validate({ body: loginSchema }),
    controller.login,
  );
  router.post('/refresh', strictLimit, requireCsrf, controller.refresh);
  router.post('/logout', requireCsrf, authenticate, controller.logout);
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
    strictLimit,
    accountLimit,
    requireCsrf,
    validate({ body: forgotPasswordSchema }),
    controller.forgotPassword,
  );
  router.post(
    '/reset-password',
    strictLimit,
    requireCsrf,
    validate({ body: resetPasswordSchema }),
    controller.resetPassword,
  );
  router.get(
    '/google/start',
    strictLimit,
    validate({ query: googleStartSchema }),
    controller.googleStart,
  );
  router.get(
    '/google/callback',
    strictLimit,
    validate({ query: googleCallbackSchema }),
    controller.googleCallback,
  );
  router.post(
    '/google/link/confirm',
    strictLimit,
    requireCsrf,
    validate({ body: googleLinkSchema }),
    controller.googleLinkConfirm,
  );

  return router;
};
