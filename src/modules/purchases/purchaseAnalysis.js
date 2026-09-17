import { rateLimit } from 'express-rate-limit';
import { createOpenAIReceiptAnalyzer } from '../../services/receiptAnalyzer.js';
import { DEFAULT_RECEIPT_ANALYSIS_CONFIG } from '../../config/receiptAnalysis.js';
import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createDomainError } from '../household-domain/domainError.js';
import { getAuthenticatedUserId } from '../household-domain/requestAuth.js';
import { analyzePurchaseDocumentSchema, confirmPurchaseAnalysisSchema, purchaseAnalysisParamsSchema } from './purchaseAnalysis.schemas.js';
import { analyzePurchaseDocument, confirmPurchaseDocumentAnalysis, listPurchaseDocumentAnalyses, safePurchaseAnalysisOperation } from './purchaseAnalysis.service.js';
import { requireVisiblePurchase } from './purchases.service.js';

export function createPurchaseAnalysisRateLimiter({ max = DEFAULT_RECEIPT_ANALYSIS_CONFIG.analysisLimitPerHour } = {}) {
  return rateLimit({
    windowMs: 60 * 60 * 1000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (request) => getAuthenticatedUserId(request),
    handler: (_request, _response, next) => next(createDomainError(429, 'AI_ANALYSIS_RATE_LIMIT', 'Has realizado varios análisis en poco tiempo. Inténtalo más tarde.')),
  });
}

export function registerPurchaseAnalysisRoutes({ router, prisma, requireCsrf, documentStorage, receiptAnalyzer, aiConfig }) {
  const analyzer = receiptAnalyzer ?? createOpenAIReceiptAnalyzer({ config: aiConfig });
  const limiter = createPurchaseAnalysisRateLimiter({ max: aiConfig?.analysisLimitPerHour });
  const inFlight = new Set();
  const base = '/households/:householdId/purchases/:purchaseId/documents/:documentId';
  const context = (request) => ({ ...purchaseAnalysisParamsSchema.parse(request.params), userId: getAuthenticatedUserId(request) });
  const route = (operation) => asyncRoute((request, response, next) => safePurchaseAnalysisOperation(() => operation(request, response, next)));
  const authorize = route(async (request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    await requireVisiblePurchase(prisma, context(request));
    next();
  });

  router.post(`${base}/analyze`, requireCsrf, authorize, limiter, route(async (request, response) => {
    const input = context(request);
    analyzePurchaseDocumentSchema.parse(request.body);
    // In-process guard complements the always-on per-user cost limiter. The
    // application runs one API process; no new distributed infrastructure.
    const key = `${input.userId}:${input.documentId}`;
    if (inFlight.has(key)) throw createDomainError(409, 'AI_ANALYSIS_IN_PROGRESS', 'Este documento ya se está analizando. Espera a que termine.');
    inFlight.add(key);
    try {
      return sendSuccess(response, await analyzePurchaseDocument(prisma, input, { receiptAnalyzer: analyzer, documentStorage }), { statusCode: 201 });
    } finally { inFlight.delete(key); }
  }));
  router.get(`${base}/analyses`, authorize, route(async (request, response) =>
    sendSuccess(response, await listPurchaseDocumentAnalyses(prisma, context(request)))));
  router.post(`${base}/analyses/:analysisId/confirm`, requireCsrf, authorize, route(async (request, response) =>
    sendSuccess(response, await confirmPurchaseDocumentAnalysis(prisma, context(request), confirmPurchaseAnalysisSchema.parse(request.body)))));
  return router;
}
