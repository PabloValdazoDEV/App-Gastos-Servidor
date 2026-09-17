import express from 'express';

import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { financeParamsSchema } from './finance.schemas.js';

import {
  MAX_PRIVATE_DOCUMENT_SIZE_BYTES,
  PRIVATE_DOCUMENT_CONTENT_TYPES,
  detectPrivateDocumentContentType as detectInvoiceDocumentContentType,
  sanitizePrivateDocumentFilename as sanitizeInvoiceDocumentFilename,
  canonicalizePrivateDocumentFilename as canonicalizeInvoiceDocumentFilename,
  decodePrivateDocumentFilenameHeader as decodeInvoiceDocumentFilenameHeader,
  privateDocumentContentDisposition as attachmentContentDisposition,
} from '../../services/privateDocumentFiles.js';

export { detectInvoiceDocumentContentType, sanitizeInvoiceDocumentFilename, canonicalizeInvoiceDocumentFilename, decodeInvoiceDocumentFilenameHeader, attachmentContentDisposition };

export const MAX_INVOICE_DOCUMENTS = 5;
export const MAX_INVOICE_DOCUMENT_SIZE_BYTES = MAX_PRIVATE_DOCUMENT_SIZE_BYTES;

const ALLOWED_CONTENT_TYPES = new Set(PRIVATE_DOCUMENT_CONTENT_TYPES);

export const invoiceDocumentMetadataSelect = Object.freeze({
  id: true,
  invoiceId: true,
  filename: true,
  contentType: true,
  sizeBytes: true,
  uploadedByUserId: true,
  uploadedBy: {
    select: { id: true, name: true },
  },
  createdAt: true,
});

const declaredContentType = (request) =>
  request.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';

const requireAllowedContentType = (request, _response, next) => {
  const contentType = declaredContentType(request);

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    next(
      createDomainError(
        415,
        'INVOICE_DOCUMENT_CONTENT_TYPE_UNSUPPORTED',
        'Solo se admiten archivos PDF, JPEG, PNG o WebP.',
      ),
    );
    return;
  }

  request.invoiceDocumentContentType = contentType;
  next();
};

const rawDocumentBody = express.raw({
  type: () => true,
  limit: MAX_INVOICE_DOCUMENT_SIZE_BYTES,
  inflate: false,
});

export const mapInvoiceDocumentBodyError = (error) => {
  if (!error) return undefined;
  const status = error.status ?? error.statusCode;

  if (error.type === 'entity.too.large') {
    return createDomainError(
      413,
      'INVOICE_DOCUMENT_TOO_LARGE',
      'El archivo no puede superar 10 MiB.',
    );
  }

  if (error.type === 'encoding.unsupported') {
    return createDomainError(
      415,
      'INVOICE_DOCUMENT_CONTENT_ENCODING_UNSUPPORTED',
      'Envía el archivo sin compresión de transporte.',
    );
  }

  if (
    error.type === 'request.aborted' ||
    error.type === 'request.size.invalid' ||
    (Number.isInteger(status) && status >= 400 && status < 500)
  ) {
    return createDomainError(
      400,
      'INVOICE_DOCUMENT_UPLOAD_INVALID',
      'No se pudo leer el archivo completo. Vuelve a intentarlo.',
    );
  }

  return error;
};

const parseRawDocumentBody = (request, response, next) => {
  rawDocumentBody(request, response, (error) => {
    next(mapInvoiceDocumentBodyError(error));
  });
};

const validateDocumentContent = (content, contentType) => {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw createDomainError(
      400,
      'INVOICE_DOCUMENT_EMPTY',
      'Selecciona un archivo que contenga datos.',
    );
  }

  if (content.length > MAX_INVOICE_DOCUMENT_SIZE_BYTES) {
    throw createDomainError(
      413,
      'INVOICE_DOCUMENT_TOO_LARGE',
      'El archivo no puede superar 10 MiB.',
    );
  }

  if (detectInvoiceDocumentContentType(content) !== contentType) {
    throw createDomainError(
      415,
      'INVOICE_DOCUMENT_SIGNATURE_INVALID',
      'El contenido del archivo no coincide con su tipo declarado.',
    );
  }
};

const documentNotFound = () =>
  createDomainError(
    404,
    'INVOICE_DOCUMENT_NOT_FOUND',
    'No se encontró el documento solicitado.',
  );

export const registerInvoiceDocumentRoutes = ({
  router,
  prisma,
  requireCsrf,
  memberAccess,
  getInvoice,
}) => {
  const documentCollectionPath =
    '/households/:householdId/invoices/:invoiceId/documents';
  const documentItemPath = `${documentCollectionPath}/:documentId`;

  const authorizeInvoice = asyncRoute(async (request, _response, next) => {
    const { householdId, invoiceId } = financeParamsSchema.parse(request.params);
    await memberAccess(prisma, request);
    request.financeInvoice = await getInvoice(
      prisma,
      householdId,
      invoiceId,
      request.auth.userId,
    );
    next();
  });

  const prepareUpload = (request, _response, next) => {
    request.invoiceDocumentFilename = decodeInvoiceDocumentFilenameHeader(
      request.get('x-document-filename'),
    );
    next();
  };

  router.get(
    documentCollectionPath,
    authorizeInvoice,
    asyncRoute(async (request, response) => {
      const documents = await prisma.invoiceDocument.findMany({
        where: { invoiceId: request.financeInvoice.id },
        select: invoiceDocumentMetadataSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return sendSuccess(response, documents);
    }),
  );

  router.post(
    documentCollectionPath,
    requireCsrf,
    authorizeInvoice,
    prepareUpload,
    requireAllowedContentType,
    parseRawDocumentBody,
    asyncRoute(async (request, response) => {
      const content = request.body;
      const contentType = request.invoiceDocumentContentType;
      validateDocumentContent(content, contentType);
      const filename = canonicalizeInvoiceDocumentFilename(
        request.invoiceDocumentFilename,
        contentType,
      );

      const document = await runSerializableTransaction(
        prisma,
        async (database) => {
          const count = await database.invoiceDocument.count({
            where: { invoiceId: request.financeInvoice.id },
          });

          if (count >= MAX_INVOICE_DOCUMENTS) {
            throw createDomainError(
              409,
              'INVOICE_DOCUMENT_LIMIT_REACHED',
              'Cada factura puede tener como máximo 5 documentos.',
            );
          }

          const created = await database.invoiceDocument.create({
            data: {
              invoiceId: request.financeInvoice.id,
              uploadedByUserId: request.auth.userId,
              filename,
              contentType,
              sizeBytes: content.length,
              content,
            },
            select: invoiceDocumentMetadataSelect,
          });
          await createAuditLog(database, {
            actorUserId: request.auth.userId,
            householdId: request.financeInvoice.householdId,
            action: 'EXPENSE_CHANGED',
            resourceType: 'InvoiceDocument',
            resourceId: created.id,
            metadata: {
              operation: 'UPLOAD',
              invoiceId: request.financeInvoice.id,
              documentId: created.id,
            },
          });
          return created;
        },
      );

      return sendSuccess(response, document, { statusCode: 201 });
    }),
  );

  router.get(
    `${documentItemPath}/content`,
    authorizeInvoice,
    asyncRoute(async (request, response) => {
      const { documentId } = financeParamsSchema.parse(request.params);
      const document = await prisma.invoiceDocument.findFirst({
        where: { id: documentId, invoiceId: request.financeInvoice.id },
        select: {
          filename: true,
          contentType: true,
          sizeBytes: true,
          content: true,
        },
      });

      if (!document) throw documentNotFound();

      response.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': attachmentContentDisposition(document.filename),
        'Content-Length': String(document.sizeBytes),
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Content-Type': document.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      return response.status(200).end(Buffer.from(document.content));
    }),
  );

  router.delete(
    documentItemPath,
    requireCsrf,
    authorizeInvoice,
    asyncRoute(async (request, response) => {
      const { documentId } = financeParamsSchema.parse(request.params);
      await prisma.$transaction(async (database) => {
        const deleted = await database.invoiceDocument.deleteMany({
          where: { id: documentId, invoiceId: request.financeInvoice.id },
        });

        if (deleted.count !== 1) throw documentNotFound();
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          householdId: request.financeInvoice.householdId,
          action: 'EXPENSE_CHANGED',
          resourceType: 'InvoiceDocument',
          resourceId: documentId,
          metadata: {
            operation: 'DELETE',
            invoiceId: request.financeInvoice.id,
            documentId,
          },
        });
      });
      return sendSuccess(response, { id: documentId, deleted: true });
    }),
  );

  return router;
};
