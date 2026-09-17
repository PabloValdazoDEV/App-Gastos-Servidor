import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../errors/AppError.js';
import { validateReceiptExtraction } from '../../services/receiptExtractionSchema.js';
import { ReceiptAnalysisError } from '../../services/receiptAnalyzer.js';
import { PRIVATE_DOCUMENT_CONTENT_TYPES } from '../../services/privateDocumentFiles.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { requireHouseholdRole } from '../households/authorization.js';
import { postgresPurchaseDocumentStorage } from './documentStorage.js';
import { validatePurchaseDocumentContent } from './purchaseDocuments.js';
import { reviewedPurchaseTotalMismatch } from './purchaseAnalysis.schemas.js';
import { createPurchaseItemSchema, updatePurchaseSchema } from './purchases.schemas.js';
import { getPurchase, requireVisiblePurchase, updatePurchaseInTransaction } from './purchases.service.js';

const privateTypes = new Set(PRIVATE_DOCUMENT_CONTENT_TYPES);
const error = (status, code, message) => createDomainError(status, code, message);
const operationFailed = () => error(503, 'AI_ANALYSIS_UNAVAILABLE', 'No se ha podido completar la operación. Inténtalo de nuevo.');
const sourceSelect = { id: true, purchaseId: true, filename: true, contentType: true, sizeBytes: true };

export function purchaseAnalysisVersion(purchase) {
  // Prisma includes can change relation/object ordering without a data change.
  // Canonicalize recursively while retaining every value (including versions).
  const canonical = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(purchase))).digest('hex');
}

export function purchaseAnalysisDto(analysis, purchase) {
  const result = { ...analysis };
  delete result.sourcePurchaseVersion;
  return { ...result, purchaseVersion: purchaseAnalysisVersion(purchase) };
}

// Treat all unknown infrastructure failures as operational before reaching the
// development logger. Prisma/provider errors may embed document data in messages.
export async function safePurchaseAnalysisOperation(operation) {
  try { return await operation(); } catch (failure) {
    if (failure instanceof AppError) throw failure;
    if (Array.isArray(failure?.issues)) {
      throw error(400, 'AI_REVIEW_INVALID', 'Revisa los campos indicados antes de guardar los datos.');
    }
    throw operationFailed();
  }
}

async function documentFor(database, context) {
  const document = await database.purchaseDocument.findFirst({
    where: { id: context.documentId, purchaseId: context.purchaseId }, select: sourceSelect,
  });
  if (!document) throw error(404, 'PURCHASE_DOCUMENT_NOT_FOUND', 'No se encontró el documento solicitado.');
  return document;
}

async function auditAnalysis(database, context, analysis, action, extra = {}) {
  await createAuditLog(database, {
    actorUserId: context.userId, householdId: context.householdId, action,
    resourceType: 'PurchaseDocumentAnalysis', resourceId: analysis.id,
    metadata: {
      purchaseId: context.purchaseId, documentId: context.documentId, analysisId: analysis.id,
      model: analysis.model, status: analysis.status, failureCode: analysis.failureCode,
      inputTokens: analysis.inputTokens, outputTokens: analysis.outputTokens, totalTokens: analysis.totalTokens, ...extra,
    },
  });
}

function safeUsage(value) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].map((field) => [field,
    Number.isInteger(value?.[field]) && value[field] >= 0 && value[field] <= 2_147_483_647 ? value[field] : null]));
}

export async function analyzePurchaseDocument(prisma, context, {
  receiptAnalyzer, documentStorage = postgresPurchaseDocumentStorage,
}) {
  const source = await runSerializableTransaction(prisma, async (database) => {
    const purchase = await requireVisiblePurchase(database, context);
    const document = await documentFor(database, context);
    if (!privateTypes.has(document.contentType)) throw error(415, 'AI_DOCUMENT_UNSUPPORTED', 'Solo se pueden analizar documentos PDF, JPEG, PNG o WebP.');
    const content = await documentStorage.get(database, { documentId: document.id });
    if (!Buffer.isBuffer(content) || content.length !== document.sizeBytes) throw operationFailed();
    validatePurchaseDocumentContent(content, document.contentType);
    return { document, content, sourcePurchaseVersion: purchaseAnalysisVersion(purchase) };
  });

  // Exactly one provider call, outside every transaction/retry. No purchase,
  // user profile, household data, secrets or public URL is sent to the analyzer.
  let result;
  let providerFailure;
  try {
    result = await receiptAnalyzer.analyze({ content: source.content, contentType: source.document.contentType, filename: source.document.filename });
    result = { ...result, extractedData: validateReceiptExtraction(result.extractedData) };
  } catch (failure) {
    providerFailure = failure instanceof ReceiptAnalysisError ? failure
      : { statusCode: 502, failureCode: result ? 'AI_SCHEMA_INVALID' : 'AI_PROVIDER_ERROR', usage: result ?? null };
  }
  const saved = await runSerializableTransaction(prisma, async (database) => {
    // A remote call can outlive permission, ownership or document changes. Do
    // not return even the extracted preview after access has been revoked.
    const purchase = await requireVisiblePurchase(database, context);
    await documentFor(database, context);
    const analysis = await database.purchaseDocumentAnalysis.create({ data: {
      purchaseDocumentId: context.documentId, requestedByUserId: context.userId,
      provider: receiptAnalyzer.provider,
      model: !providerFailure && typeof result.model === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(result.model) ? result.model : receiptAnalyzer.model,
      status: providerFailure ? 'FAILED' : 'COMPLETED',
      extractedData: providerFailure ? Prisma.DbNull : result.extractedData,
      reviewedData: Prisma.DbNull, sourcePurchaseVersion: source.sourcePurchaseVersion,
      failureCode: providerFailure?.failureCode ?? null,
      ...safeUsage(providerFailure ? providerFailure.usage : result),
    } });
    await auditAnalysis(database, context, analysis, providerFailure ? 'PURCHASE_DOCUMENT_ANALYSIS_FAILED' : 'PURCHASE_DOCUMENT_ANALYZED');
    return purchaseAnalysisDto(analysis, purchase);
  });
  if (providerFailure) {
    throw error(providerFailure.statusCode ?? 502, providerFailure.failureCode,
      providerFailure.failureCode === 'AI_NOT_CONFIGURED' ? 'El análisis con IA no está configurado en el servidor.'
        : 'No se ha podido analizar el documento. Inténtalo de nuevo.');
  }
  return saved;
}

export async function listPurchaseDocumentAnalyses(prisma, context) {
  return runSerializableTransaction(prisma, async (database) => {
    const purchase = await requireVisiblePurchase(database, context);
    await documentFor(database, context);
    const analyses = await database.purchaseDocumentAnalysis.findMany({
      where: { purchaseDocumentId: context.documentId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return analyses.map((analysis) => purchaseAnalysisDto(analysis, purchase));
  });
}

export async function confirmPurchaseDocumentAnalysis(prisma, context, input) {
  return runSerializableTransaction(prisma, async (database) => {
    const { household } = await requireHouseholdRole(database, context);
    const purchase = await requireVisiblePurchase(database, context);
    await documentFor(database, context);
    const analysis = await database.purchaseDocumentAnalysis.findFirst({
      where: { id: context.analysisId, purchaseDocumentId: context.documentId },
    });
    if (!analysis) throw error(404, 'AI_ANALYSIS_NOT_FOUND', 'No se encontró el análisis solicitado.');
    if (analysis.status !== 'COMPLETED') throw error(409, 'AI_ANALYSIS_NOT_CONFIRMABLE', 'Este análisis ya fue confirmado o no contiene datos que se puedan aplicar.');
    if (input.purchaseVersion !== purchaseAnalysisVersion(purchase)) throw error(409, 'AI_ANALYSIS_STALE', 'La compra ha cambiado. Vuelve a abrir la revisión y comprueba los datos antes de confirmar.');
    const reviewed = input.reviewedData;
    if (reviewedPurchaseTotalMismatch(reviewed) && !input.acknowledgeTotalMismatch) {
      throw error(400, 'AI_TOTAL_MISMATCH_REQUIRES_CONFIRMATION', 'El total no coincide con la suma de los productos. Revisa y confirma esta diferencia.');
    }
    if ((input.apply.total || (input.apply.items === 'ADD' && reviewed.items.some((item) => item.totalPriceCents !== null)))
      && reviewed.currency !== household.currency) {
      throw error(400, 'AI_CURRENCY_MISMATCH', 'Comprueba la moneda. Los importes aplicados deben estar en la moneda del hogar; no se convierten automáticamente.');
    }
    if (input.apply.items === 'ADD' && purchase.items.length + reviewed.items.length > 50) {
      throw error(400, 'PURCHASE_ITEMS_LIMIT', 'Una compra admite como máximo 50 productos, incluidos los existentes.');
    }
    const patch = {
      ...(input.apply.merchant ? { merchant: reviewed.merchant } : {}),
      ...(input.apply.purchaseDate ? { purchaseDate: reviewed.purchaseDate } : {}),
      ...(input.apply.total ? { totalCents: reviewed.totalCents } : {}),
    };
    if (Object.keys(patch).length) await updatePurchaseInTransaction(database, context, updatePurchaseSchema.parse(patch));
    else await database.purchase.update({ where: { id: purchase.id }, data: { updatedAt: new Date() } });
    const addedItemIds = [];
    if (input.apply.items === 'ADD') {
      for (const item of reviewed.items) {
        const data = createPurchaseItemSchema.parse({
          name: item.name, quantity: item.quantity, brand: item.brand, model: item.model, priceCents: item.totalPriceCents,
        });
        const created = await database.purchaseItem.create({ data: { purchaseId: purchase.id, ...data } });
        addedItemIds.push(created.id);
        await createAuditLog(database, {
          actorUserId: context.userId, householdId: context.householdId, action: 'PURCHASE_ITEM_CREATED',
          resourceType: 'PurchaseItem', resourceId: created.id,
          metadata: { purchaseId: purchase.id, analysisId: analysis.id },
        });
      }
    }
    const confirmed = await database.purchaseDocumentAnalysis.update({ where: { id: analysis.id }, data: {
      status: 'CONFIRMED', reviewedData: { ...reviewed, apply: input.apply, acknowledgeTotalMismatch: input.acknowledgeTotalMismatch },
      confirmedAt: new Date(), confirmedByUserId: context.userId,
    } });
    await auditAnalysis(database, context, confirmed, 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED', { appliedFields: Object.keys(patch), addedItemIds });
    const refreshed = await requireVisiblePurchase(database, context);
    return { analysis: purchaseAnalysisDto(confirmed, refreshed), purchase: await getPurchase(database, context) };
  });
}
