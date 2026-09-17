import express from 'express';
import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { getAuthenticatedUserId } from '../household-domain/requestAuth.js';
import { createPurchaseItemSchema, createPurchaseSchema, purchaseParamsSchema, updatePurchaseItemSchema, updatePurchaseSchema } from './purchases.schemas.js';
import { archivePurchase, createPurchase, getPurchase, listPurchases, mutatePurchaseItem, updatePurchase } from './purchases.service.js';
import { registerPurchaseDocumentRoutes } from './purchaseDocuments.js';
import { installmentPaymentSchema, revertInstallmentPaymentSchema } from './paymentSchemas.js';
import { mutatePurchaseInstallmentPayment } from './purchasePayments.service.js';
import { registerPurchaseAnalysisRoutes } from './purchaseAnalysis.js';

export function createPurchasesRouter({ prisma, authenticate, requireCsrf, documentStorage, receiptAnalyzer, aiConfig }) {
  if (!prisma || !authenticate || !requireCsrf) throw new TypeError('createPurchasesRouter requiere prisma, authenticate y requireCsrf.');
  const router = express.Router();
  const base = '/households/:householdId/purchases';
  const context = (request) => ({ ...purchaseParamsSchema.parse(request.params), userId: getAuthenticatedUserId(request) });
  router.use(base, authenticate);
  router.get(base, asyncRoute(async (req, res) => sendSuccess(res, await listPurchases(prisma, context(req)))));
  router.post(base, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await createPurchase(prisma, context(req), createPurchaseSchema.parse(req.body)), { statusCode: 201 })));
  router.get(`${base}/:purchaseId`, asyncRoute(async (req, res) => sendSuccess(res, await getPurchase(prisma, context(req)))));
  router.patch(`${base}/:purchaseId`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await updatePurchase(prisma, context(req), updatePurchaseSchema.parse(req.body)))));
  router.delete(`${base}/:purchaseId`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await archivePurchase(prisma, context(req)))));
  router.post(`${base}/:purchaseId/items`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await mutatePurchaseItem(prisma, context(req), 'create', createPurchaseItemSchema.parse(req.body)), { statusCode: 201 })));
  router.patch(`${base}/:purchaseId/items/:itemId`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await mutatePurchaseItem(prisma, context(req), 'update', updatePurchaseItemSchema.parse(req.body)))));
  router.delete(`${base}/:purchaseId/items/:itemId`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res, await mutatePurchaseItem(prisma, context(req), 'delete'))));
  registerPurchaseDocumentRoutes({ router, prisma, requireCsrf, documentStorage });
  registerPurchaseAnalysisRoutes({ router, prisma, requireCsrf, documentStorage, receiptAnalyzer, aiConfig });
  const installmentPath = `${base}/:purchaseId/installments/:installmentId`;
  router.post(`${installmentPath}/pay`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res,
    await mutatePurchaseInstallmentPayment(prisma, context(req), 'pay', installmentPaymentSchema.parse(req.body)))));
  router.patch(`${installmentPath}/payment`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res,
    await mutatePurchaseInstallmentPayment(prisma, context(req), 'correct', installmentPaymentSchema.parse(req.body)))));
  router.delete(`${installmentPath}/payment`, requireCsrf, asyncRoute(async (req, res) => sendSuccess(res,
    await mutatePurchaseInstallmentPayment(prisma, context(req), 'revert', revertInstallmentPaymentSchema.parse(req.body)))));
  return router;
}
