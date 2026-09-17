import express from 'express';
import { z } from 'zod';

import {
  MAX_PRIVATE_DOCUMENT_SIZE_BYTES,
  PRIVATE_DOCUMENT_CONTENT_TYPES,
  canonicalizePrivateDocumentFilename,
  decodePrivateDocumentFilenameHeader,
  detectPrivateDocumentContentType,
  privateDocumentContentDisposition,
} from '../../services/privateDocumentFiles.js';
import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { uuidSchema } from '../household-domain/commonSchemas.js';
import { createDomainError } from '../household-domain/domainError.js';
import { getAuthenticatedUserId } from '../household-domain/requestAuth.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { postgresPurchaseDocumentStorage } from './documentStorage.js';
import { requireVisiblePurchase } from './purchases.service.js';

export const MAX_PURCHASE_DOCUMENT_SIZE_BYTES = MAX_PRIVATE_DOCUMENT_SIZE_BYTES;
const ERROR_PREFIX = 'PURCHASE_DOCUMENT';
const allowedContentTypes = new Set(PRIVATE_DOCUMENT_CONTENT_TYPES);
const typeSchema = z.enum(['RECEIPT', 'INVOICE', 'WARRANTY', 'OTHER']);
const paramsSchema = z.object({ householdId: uuidSchema, purchaseId: uuidSchema, documentId: uuidSchema.optional() }).strict();
const uploadQuerySchema = z.object({ type: typeSchema.default('OTHER'), purchaseItemId: uuidSchema.optional() }).strict();
export const updatePurchaseDocumentSchema = z.object({
  type: typeSchema.optional(), purchaseItemId: uuidSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Indica algún cambio.');
const contentQuerySchema = z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') }).strict();

export const purchaseDocumentMetadataSelect = Object.freeze({
  id: true, purchaseId: true, purchaseItemId: true, uploadedByUserId: true,
  uploadedBy: { select: { id: true, name: true } },
  type: true, filename: true, contentType: true, sizeBytes: true, createdAt: true, updatedAt: true,
});

const documentError = (status, suffix, message) => createDomainError(status, `${ERROR_PREFIX}_${suffix}`, message);
const tooLarge = () => documentError(413, 'TOO_LARGE', 'El archivo supera el tamaño máximo permitido.');
const documentNotFound = () => documentError(404, 'NOT_FOUND', 'No se encontró el documento solicitado.');
const storageFailure = () => documentError(503, 'STORAGE_UNAVAILABLE', 'No se pudo completar la operación con el archivo. Vuelve a intentarlo.');
const contextFor = (request) => ({ ...paramsSchema.parse(request.params), userId: getAuthenticatedUserId(request) });

async function useStorage(operation) {
  try {
    return await operation();
  } catch (error) {
    // Preserve serializable retries; never expose provider errors or internal
    // locations. The surrounding transaction still rolls metadata/bytes back.
    if (error?.code === 'P2034') throw error;
    throw storageFailure();
  }
}

export function validatePurchaseDocumentContent(content, contentType) {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw documentError(400, 'EMPTY', 'Selecciona un archivo que contenga datos.');
  }
  if (content.length > MAX_PURCHASE_DOCUMENT_SIZE_BYTES) throw tooLarge();
  if (!allowedContentTypes.has(contentType)) {
    throw documentError(415, 'CONTENT_TYPE_UNSUPPORTED', 'Solo se admiten archivos PDF, JPEG, PNG o WebP.');
  }
  if (detectPrivateDocumentContentType(content) !== contentType) {
    throw documentError(415, 'SIGNATURE_INVALID', 'El contenido del archivo no coincide con su tipo declarado.');
  }
}

export function mapPurchaseDocumentBodyError(error) {
  if (!error) return undefined;
  if (error.type === 'entity.too.large') return tooLarge();
  if (error.type === 'encoding.unsupported') {
    return documentError(415, 'CONTENT_ENCODING_UNSUPPORTED', 'Envía el archivo sin compresión de transporte.');
  }
  const status = error.status ?? error.statusCode;
  if (['request.aborted', 'request.size.invalid'].includes(error.type)
    || (Number.isInteger(status) && status >= 400 && status < 500)) {
    return documentError(400, 'UPLOAD_INVALID', 'No se pudo leer el archivo completo. Vuelve a intentarlo.');
  }
  return error;
}

const rawBody = express.raw({ type: () => true, limit: MAX_PURCHASE_DOCUMENT_SIZE_BYTES, inflate: false });
const parseRawBody = (request, response, next) => rawBody(request, response, (error) => next(mapPurchaseDocumentBodyError(error)));

function prepareUpload(request, _response, next) {
  request.purchaseDocumentMetadata = uploadQuerySchema.parse(request.query);
  request.purchaseDocumentContentType = request.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (!allowedContentTypes.has(request.purchaseDocumentContentType)) {
    throw documentError(415, 'CONTENT_TYPE_UNSUPPORTED', 'Solo se admiten archivos PDF, JPEG, PNG o WebP.');
  }
  // express.raw checks declared length before buffering and safely drains a
  // rejected upload. Replying here while the client still sends bytes causes
  // EPIPE instead of delivering the actionable 413 response to the user.
  request.purchaseDocumentFilename = canonicalizePrivateDocumentFilename(
    decodePrivateDocumentFilenameHeader(request.get('x-document-filename'), ERROR_PREFIX),
    request.purchaseDocumentContentType, ERROR_PREFIX,
  );
  next();
}

function requirePurchaseItem(purchase, purchaseItemId) {
  if (purchaseItemId && !purchase.items.some((item) => item.id === purchaseItemId)) {
    throw documentError(400, 'ITEM_INVALID', 'Selecciona un producto que pertenezca a esta compra.');
  }
}

async function findDocument(database, context) {
  const document = await database.purchaseDocument.findFirst({
    where: { id: context.documentId, purchaseId: context.purchaseId }, select: purchaseDocumentMetadataSelect,
  });
  if (!document) throw documentNotFound();
  return document;
}

async function auditDocument(database, context, documentId, action) {
  await createAuditLog(database, {
    actorUserId: context.userId, householdId: context.householdId, action,
    resourceType: 'PurchaseDocument', resourceId: documentId,
    metadata: { purchaseId: context.purchaseId, documentId },
  });
}

// Parent writes serialize document mutations against item deletion, archiving,
// and ownership changes, and authorization is repeated after the body is read.
async function lockVisiblePurchase(database, context) {
  const purchase = await requireVisiblePurchase(database, context);
  await database.purchase.update({ where: { id: purchase.id }, data: { updatedAt: new Date() } });
  return purchase;
}

export function registerPurchaseDocumentRoutes({ router, prisma, requireCsrf, documentStorage = postgresPurchaseDocumentStorage }) {
  for (const method of ['save', 'get', 'delete']) {
    if (typeof documentStorage[method] !== 'function') throw new TypeError(`documentStorage.${method} es obligatorio.`);
  }
  const collectionPath = '/households/:householdId/purchases/:purchaseId/documents';
  const itemPath = `${collectionPath}/:documentId`;
  const authorize = asyncRoute(async (request, _response, next) => {
    await requireVisiblePurchase(prisma, contextFor(request));
    next();
  });

  router.get(collectionPath, authorize, asyncRoute(async (request, response) => {
    const context = contextFor(request);
    const documents = await runSerializableTransaction(prisma, async (database) => {
      await requireVisiblePurchase(database, context);
      return database.purchaseDocument.findMany({
        where: { purchaseId: context.purchaseId }, select: purchaseDocumentMetadataSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
    response.set('Cache-Control', 'private, no-store');
    return sendSuccess(response, documents);
  }));

  router.post(collectionPath, requireCsrf, authorize, prepareUpload, parseRawBody, asyncRoute(async (request, response) => {
    const context = contextFor(request);
    const content = request.body;
    validatePurchaseDocumentContent(content, request.purchaseDocumentContentType);
    const document = await runSerializableTransaction(prisma, async (database) => {
      const purchase = await lockVisiblePurchase(database, context);
      const { type, purchaseItemId = null } = request.purchaseDocumentMetadata;
      requirePurchaseItem(purchase, purchaseItemId);
      const created = await database.purchaseDocument.create({
        data: {
          purchaseId: purchase.id, purchaseItemId, type, uploadedByUserId: context.userId,
          filename: request.purchaseDocumentFilename, contentType: request.purchaseDocumentContentType, sizeBytes: content.length,
        }, select: purchaseDocumentMetadataSelect,
      });
      await useStorage(() => documentStorage.save(database, { documentId: created.id, content }));
      await auditDocument(database, context, created.id, 'PURCHASE_DOCUMENT_ADDED');
      return created;
    });
    response.set('Cache-Control', 'private, no-store');
    return sendSuccess(response, document, { statusCode: 201 });
  }));

  router.get(`${itemPath}/content`, authorize, asyncRoute(async (request, response) => {
    const context = contextFor(request);
    const { disposition } = contentQuerySchema.parse(request.query);
    const { document, content } = await runSerializableTransaction(prisma, async (database) => {
      await requireVisiblePurchase(database, context);
      const document = await findDocument(database, context);
      const content = await useStorage(() => documentStorage.get(database, { documentId: document.id }));
      if (!Buffer.isBuffer(content) || content.length !== document.sizeBytes) throw storageFailure();
      return { document, content };
    });
    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': privateDocumentContentDisposition(document.filename, disposition),
      'Content-Length': String(document.sizeBytes),
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Type': document.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    return response.status(200).end(content);
  }));

  router.patch(itemPath, requireCsrf, authorize, asyncRoute(async (request, response) => {
    const context = contextFor(request);
    const input = updatePurchaseDocumentSchema.parse(request.body);
    const document = await runSerializableTransaction(prisma, async (database) => {
      const purchase = await lockVisiblePurchase(database, context);
      await findDocument(database, context);
      requirePurchaseItem(purchase, input.purchaseItemId);
      const changed = await database.purchaseDocument.update({
        where: { id: context.documentId }, data: input, select: purchaseDocumentMetadataSelect,
      });
      await auditDocument(database, context, changed.id, 'PURCHASE_DOCUMENT_CHANGED');
      return changed;
    });
    response.set('Cache-Control', 'private, no-store');
    return sendSuccess(response, document);
  }));

  router.delete(itemPath, requireCsrf, authorize, asyncRoute(async (request, response) => {
    const context = contextFor(request);
    await runSerializableTransaction(prisma, async (database) => {
      await lockVisiblePurchase(database, context);
      const document = await findDocument(database, context);
      // Delete binary first; failure aborts metadata deletion. If a later step
      // fails, the PostgreSQL adapter rolls the binary deletion back as well.
      await useStorage(() => documentStorage.delete(database, { documentId: document.id }));
      await database.purchaseDocument.delete({ where: { id: document.id } });
      await auditDocument(database, context, document.id, 'PURCHASE_DOCUMENT_DELETED');
    });
    response.set('Cache-Control', 'private, no-store');
    return sendSuccess(response, { id: context.documentId, deleted: true });
  }));
  return router;
}
