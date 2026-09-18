import { createHash } from 'node:crypto';
import express from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { sendSuccess } from '../../utils/httpResponses.js';
import { ReceiptAnalysisError, receiptAnalysisUsage } from '../../services/receiptAnalyzer.js';
import { validateReceiptExtraction } from '../../services/receiptExtractionSchema.js';
import { decodePrivateDocumentFilenameHeader, canonicalizePrivateDocumentFilename, PRIVATE_DOCUMENT_CONTENT_TYPES } from '../../services/privateDocumentFiles.js';
import { createDomainError } from '../household-domain/domainError.js';
import { uuidSchema } from '../household-domain/commonSchemas.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { getAuthenticatedUserId } from '../household-domain/requestAuth.js';
import { createAuditLog } from '../household-domain/audit.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { requireHouseholdRole } from '../households/authorization.js';
import { createPurchaseSchema } from './purchases.schemas.js';
import { createPurchaseInTransaction, getPurchase } from './purchases.service.js';
import { purchaseAnalysisVersion, safePurchaseAnalysisOperation } from './purchaseAnalysis.service.js';
import { analyzePurchaseDocumentSchema } from './purchaseAnalysis.schemas.js';
import { MAX_PURCHASE_DOCUMENT_SIZE_BYTES, mapPurchaseDocumentBodyError, validatePurchaseDocumentContent } from './purchaseDocuments.js';
import { postgresPurchaseDocumentStorage } from './documentStorage.js';

const LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 20;
const params = z.object({ householdId: uuidSchema, draftId: uuidSchema.optional() }).strict();
const confirmation = z.object({
  purchase: createPurchaseSchema.refine((purchase) => purchase.items.length === 1, 'Registra un solo producto por compra.'),
  analysisId: uuidSchema.nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
const metadata = {
  id: true, filename: true, contentType: true, sizeBytes: true, expiresAt: true, createdAt: true,
};
const analysisOrder = [{ createdAt: 'desc' }, { id: 'desc' }];
const error = createDomainError;
const contextFor = (request) => ({ ...params.parse(request.params), userId: getAuthenticatedUserId(request) });

async function ownedDraft(database, context, { content = false, confirmed = false } = {}) {
  await requireHouseholdRole(database, context);
  const draft = await database.purchaseDraft.findFirst({
    where: { id: context.draftId, householdId: context.householdId, uploadedByUserId: context.userId },
    select: { ...metadata, confirmedPurchaseId: true, confirmationHash: true, ...(content ? { content: true } : {}) },
  });
  if (!draft || (!draft.confirmedPurchaseId && draft.expiresAt <= new Date())) {
    throw error(404, 'PURCHASE_DRAFT_NOT_FOUND', 'El borrador no está disponible o ha caducado. Vuelve a subir el archivo.');
  }
  if (draft.confirmedPurchaseId && !confirmed) throw error(409, 'PURCHASE_DRAFT_CONFIRMED', 'Este documento ya se guardó en una compra.');
  return draft;
}

export function registerPurchaseDraftRoutes({ router, prisma, authenticate, requireCsrf, analyzer, limiter, documentStorage = postgresPurchaseDocumentStorage }) {
  const base = '/households/:householdId/purchase-drafts';
  const inFlight = new Set();
  const route = (operation) => asyncRoute((req, res, next) => safePurchaseAnalysisOperation(() => operation(req, res, next)));
  router.use(base, authenticate, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const authorize = route(async (req, _res, next) => { await requireHouseholdRole(prisma, contextFor(req)); next(); });
  const authorizeDraft = route(async (req, _res, next) => { await ownedDraft(prisma, contextFor(req)); next(); });
  const raw = express.raw({ type: () => true, limit: MAX_PURCHASE_DOCUMENT_SIZE_BYTES, inflate: false });
  router.get(base, authorize, route(async (req, res) => {
    const context = contextFor(req);
    const drafts = await prisma.purchaseDraft.findMany({
      where: { householdId: context.householdId, uploadedByUserId: context.userId, confirmedPurchaseId: null, expiresAt: { gt: new Date() } },
      select: metadata, orderBy: { createdAt: 'desc' }, take: MAX_DRAFTS,
    });
    return sendSuccess(res, drafts);
  }));
  router.post(base, requireCsrf, authorize, (req, _res, next) => {
    const contentType = req.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!PRIVATE_DOCUMENT_CONTENT_TYPES.includes(contentType)) return next(error(415, 'AI_FILE_UNSUPPORTED', 'Selecciona un PDF, JPEG, PNG o WebP.'));
    req.draftContentType = contentType;
    next();
  }, (req, res, next) => raw(req, res, (failure) => next(mapPurchaseDocumentBodyError(failure))), route(async (req, res) => {
    const context = contextFor(req);
    validatePurchaseDocumentContent(req.body, req.draftContentType);
    const filename = canonicalizePrivateDocumentFilename(decodePrivateDocumentFilenameHeader(req.get('x-document-filename'), 'PURCHASE_DOCUMENT'), req.draftContentType, 'PURCHASE_DOCUMENT');
    const draft = await runSerializableTransaction(prisma, async (database) => {
      await requireHouseholdRole(database, context);
      const owner = { householdId: context.householdId, uploadedByUserId: context.userId, confirmedPurchaseId: null };
      // Expired, unconfirmed private uploads are disposable; never touch saved purchases.
      await database.purchaseDraft.deleteMany({ where: { ...owner, expiresAt: { lte: new Date() } } });
      if (await database.purchaseDraft.count({ where: owner }) >= MAX_DRAFTS) throw error(409, 'PURCHASE_DRAFT_LIMIT', 'Completa o elimina alguno de tus borradores antes de subir otro archivo.');
      return database.purchaseDraft.create({ data: {
        householdId: context.householdId, uploadedByUserId: context.userId, filename,
        contentType: req.draftContentType, sizeBytes: req.body.length, content: req.body,
        expiresAt: new Date(Date.now() + LIFETIME_MS),
      }, select: metadata });
    });
    return sendSuccess(res, draft, { statusCode: 201 });
  }));
  router.get(`${base}/:draftId`, authorizeDraft, route(async (req, res) => {
    const context = contextFor(req);
    const result = await runSerializableTransaction(prisma, async (database) => {
      const draft = await ownedDraft(database, context);
      const analyses = await database.purchaseDraftAnalysis.findMany({ where: { draftId: draft.id }, orderBy: analysisOrder });
      return { ...Object.fromEntries(Object.keys(metadata).map((key) => [key, draft[key]])), analyses };
    });
    return sendSuccess(res, result);
  }));
  router.delete(`${base}/:draftId`, requireCsrf, authorizeDraft, route(async (req, res) => {
    const context = contextFor(req);
    await runSerializableTransaction(prisma, async (database) => {
      const draft = await ownedDraft(database, context);
      await database.purchaseDraft.delete({ where: { id: draft.id } });
    });
    return sendSuccess(res, { deleted: true });
  }));
  router.post(`${base}/:draftId/analyze`, requireCsrf, authorizeDraft, limiter, route(async (req, res) => {
    analyzePurchaseDocumentSchema.parse(req.body);
    const context = contextFor(req);
    if (inFlight.has(context.draftId)) throw error(409, 'AI_ANALYSIS_IN_PROGRESS', 'Este archivo ya se está analizando.');
    inFlight.add(context.draftId);
    try {
      const source = await ownedDraft(prisma, context, { content: true });
      let result;
      let failure;
      try {
        result = await analyzer.analyze({ content: Buffer.from(source.content), contentType: source.contentType });
        result = { ...result, extractedData: validateReceiptExtraction(result.extractedData) };
      } catch (cause) { failure = cause instanceof ReceiptAnalysisError ? cause : new ReceiptAnalysisError(result ? 'AI_SCHEMA_INVALID' : 'AI_PROVIDER_ERROR'); }
      const analysis = await runSerializableTransaction(prisma, async (database) => {
        await ownedDraft(database, context);
        // Serialize completion against confirmation/deletion. Provider never runs in a retry.
        await database.purchaseDraft.update({ where: { id: context.draftId }, data: { updatedAt: new Date() } });
        return database.purchaseDraftAnalysis.create({ data: {
          draftId: context.draftId, provider: analyzer.provider,
          model: !failure && typeof result.model === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(result.model) ? result.model : analyzer.model,
          status: failure ? 'FAILED' : 'COMPLETED', extractedData: failure ? Prisma.DbNull : result.extractedData,
          failureCode: failure?.failureCode ?? null, ...receiptAnalysisUsage(failure ? failure.usage : result),
        } });
      });
      if (failure) throw failure;
      return sendSuccess(res, analysis, { statusCode: 201 });
    } finally { inFlight.delete(context.draftId); }
  }));
  router.post(`${base}/:draftId/confirm`, requireCsrf, authorize, route(async (req, res) => {
    const context = contextFor(req);
    const input = confirmation.parse(req.body);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const purchase = await runSerializableTransaction(prisma, async (database) => {
      const draft = await ownedDraft(database, context, { content: true, confirmed: true });
      if (draft.confirmedPurchaseId) {
        if (draft.confirmationHash !== hash) throw error(409, 'PURCHASE_DRAFT_CONFIRMED', 'Esta compra ya se guardó. Ábrela para modificarla.');
        return getPurchase(database, { ...context, purchaseId: draft.confirmedPurchaseId });
      }
      const { household } = await requireHouseholdRole(database, context);
      if (input.currency !== household.currency) throw error(400, 'AI_CURRENCY_MISMATCH', 'Revisa los importes en la moneda del hogar. No se convierten automáticamente.');
      const analyses = await database.purchaseDraftAnalysis.findMany({ where: { draftId: draft.id }, orderBy: analysisOrder });
      if (input.analysisId && !analyses.some((analysis) => analysis.id === input.analysisId && analysis.status === 'COMPLETED')) throw error(400, 'AI_ANALYSIS_NOT_FOUND', 'Selecciona un análisis válido de este archivo.');
      await database.purchaseDraft.update({ where: { id: draft.id }, data: { updatedAt: new Date() } });
      const created = await createPurchaseInTransaction(database, context, { ...input.purchase, singleProduct: true });
      const document = await database.purchaseDocument.create({ data: {
        purchaseId: created.id, uploadedByUserId: context.userId, filename: draft.filename,
        contentType: draft.contentType, sizeBytes: draft.sizeBytes,
        type: analyses.find((analysis) => analysis.id === input.analysisId)?.extractedData?.documentType === 'INVOICE' ? 'INVOICE' : 'RECEIPT',
      } });
      await documentStorage.save(database, { documentId: document.id, content: Buffer.from(draft.content) });
      await createAuditLog(database, { actorUserId: context.userId, householdId: context.householdId, action: 'PURCHASE_DOCUMENT_ADDED', resourceType: 'PurchaseDocument', resourceId: document.id, metadata: { purchaseId: created.id } });
      for (const analysis of analyses) {
        const selected = analysis.id === input.analysisId;
        const { id, ...data } = analysis;
        delete data.draftId;
        await database.purchaseDocumentAnalysis.create({ data: {
          ...data, id, purchaseDocumentId: document.id, requestedByUserId: context.userId,
          extractedData: analysis.extractedData ?? Prisma.DbNull,
          sourcePurchaseVersion: purchaseAnalysisVersion(created),
          status: selected ? 'CONFIRMED' : analysis.status,
          reviewedData: selected ? JSON.parse(JSON.stringify(input.purchase)) : Prisma.DbNull,
          confirmedAt: selected ? new Date() : null, confirmedByUserId: selected ? context.userId : null,
        } });
      }
      await database.purchaseDraft.update({ where: { id: draft.id }, data: { confirmedPurchaseId: created.id, confirmationHash: hash, content: null } });
      return created;
    });
    return sendSuccess(res, purchase, { statusCode: 201 });
  }));
}
