import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { createCorsOptions } from './config/cors.js';
import { prisma } from './lib/prisma.js';
import { createAuthenticate } from './middleware/authenticate.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFound.js';
import { createGeneralRateLimiter } from './middleware/rateLimit.js';
import { createRequestContext } from './middleware/requestContext.js';
import { createFinanceRouter } from './modules/finance/index.js';
import { createHouseholdDomainRouter } from './modules/household-domain/index.js';
import { createNotificationRouter } from './modules/notifications/index.js';
import { createPurchasesRouter } from './modules/purchases/index.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createLegalRouter } from './routes/legal.routes.js';

const JSON_BODY_LIMIT = '100kb';
const allowRequest = (_request, _response, next) => next();

export const createApp = ({
  config,
  logger,
  prismaClient = prisma,
  emailService,
  receiptAnalyzer,
}) => {
  if (!config || !logger) {
    throw new TypeError('createApp requires config and logger.');
  }

  const app = express();
  const corsMiddleware = cors(createCorsOptions(config.cors.origins));
  const authenticate = createAuthenticate({ prisma: prismaClient, config });
  const requireCsrf =
    config.nodeEnv === 'development'
      ? allowRequest
      : createCsrfProtection({ config });

  app.disable('x-powered-by');
  app.set('json escape', true);
  app.set('query parser', 'simple');
  app.set('trust proxy', config.security?.trustProxyHops ?? 0);

  app.use(createRequestContext(logger));
  app.use(helmet());
  app.use(
    '/api/health',
    corsMiddleware,
    createHealthRouter({
      appName: config.app.name,
      nodeEnv: config.nodeEnv,
    }),
  );
  if (config.nodeEnv !== 'development') {
    app.use('/api', createGeneralRateLimiter(config.rateLimit.general));
  }
  app.use(corsMiddleware);
  const parseJson = express.json({ limit: JSON_BODY_LIMIT, strict: true });
  const parseForm = express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT });
  app.use((request, response, next) => {
    // File uploads must authenticate, authorize the purchase and reject an
    // unsupported MIME before consuming bytes, including disguised JSON/form.
    const rawPurchaseUpload = request.method === 'POST'
      && /^\/api\/households\/[^/]+\/(?:purchases\/[^/]+\/documents|purchase-drafts)\/?$/i.test(request.path);
    if (rawPurchaseUpload) return next();
    return parseJson(request, response, (error) => {
      if (error) return next(error);
      return parseForm(request, response, next);
    });
  });

  app.use('/api/legal', createLegalRouter({ config }));

  app.use(
    '/api/auth',
    createAuthRouter({
      prisma: prismaClient,
      config,
      logger,
      emailService,
      authenticate,
      requireCsrf,
    }),
  );
  app.use(
    '/api',
    createNotificationRouter({
      prisma: prismaClient,
      authenticate,
      requireCsrf,
    }),
  );
  app.use(
    '/api',
    createFinanceRouter({
      prisma: prismaClient,
      authenticate,
      requireCsrf,
    }),
  );
  app.use(
    '/api',
    createPurchasesRouter({ prisma: prismaClient, authenticate, requireCsrf, receiptAnalyzer, aiConfig: config.ai }),
  );
  app.use(
    '/api',
    createHouseholdDomainRouter({
      prisma: prismaClient,
      config,
      authenticate,
      requireCsrf,
      emailService,
      logger,
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger, nodeEnv: config.nodeEnv }));

  return app;
};
