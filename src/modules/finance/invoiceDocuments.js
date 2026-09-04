import express from 'express';

import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { financeParamsSchema } from './finance.schemas.js';

export const MAX_INVOICE_DOCUMENTS = 5;
export const MAX_INVOICE_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const CANONICAL_EXTENSIONS = Object.freeze({
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_MAGIC = Buffer.from('WEBP', 'ascii');
const WEBP_CHUNK_TYPES = new Set(['VP8 ', 'VP8L', 'VP8X']);
const PDF_EOF = Buffer.from('%%EOF', 'ascii');

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

const startsWith = (content, signature, offset = 0) =>
  content.length >= offset + signature.length &&
  content.subarray(offset, offset + signature.length).equals(signature);

const endsWith = (content, signature) =>
  content.length >= signature.length &&
  content.subarray(content.length - signature.length).equals(signature);

const hasPdfEof = (content) => {
  let end = content.length;

  while (
    end > 0 &&
    [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(content[end - 1])
  ) {
    end -= 1;
  }

  return endsWith(content.subarray(0, end), PDF_EOF);
};

const hasValidJpegStructure = (content) => {
  if (!startsWith(content, JPEG_MAGIC) || !endsWith(content, JPEG_EOI)) {
    return false;
  }

  const dataEnd = content.length - JPEG_EOI.length;
  let offset = 2;
  let hasStartOfFrame = false;

  while (offset < dataEnd) {
    if (content[offset] !== 0xff) return false;
    while (offset < dataEnd && content[offset] === 0xff) offset += 1;
    if (offset >= dataEnd) return false;

    const marker = content[offset];
    offset += 1;

    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > dataEnd) return false;

    const segmentLength = content.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > dataEnd) return false;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 11) return false;
      const precision = content[offset + 2];
      const height = content.readUInt16BE(offset + 3);
      const width = content.readUInt16BE(offset + 5);
      const componentCount = content[offset + 7];
      if (
        precision === 0 ||
        height === 0 ||
        width === 0 ||
        componentCount === 0 ||
        segmentLength !== 8 + 3 * componentCount
      ) {
        return false;
      }
      hasStartOfFrame = true;
    }

    if (marker === 0xda) {
      const componentCount = content[offset + 2];
      return (
        hasStartOfFrame &&
        componentCount > 0 &&
        segmentLength === 6 + 2 * componentCount &&
        segmentEnd < dataEnd
      );
    }

    offset = segmentEnd;
  }

  return false;
};

const hasValidPngStructure = (content) =>
  startsWith(content, PNG_MAGIC) &&
  content.length >= PNG_MAGIC.length + 25 + PNG_IEND.length &&
  content.readUInt32BE(8) === 13 &&
  content.subarray(12, 16).toString('ascii') === 'IHDR' &&
  content.readUInt32BE(16) > 0 &&
  content.readUInt32BE(20) > 0 &&
  endsWith(content, PNG_IEND);

const hasValidWebpStructure = (content) => {
  if (
    !startsWith(content, RIFF_MAGIC) ||
    !startsWith(content, WEBP_MAGIC, 8) ||
    content.length < 20 ||
    content.readUInt32LE(4) + 8 !== content.length
  ) {
    return false;
  }

  const chunkType = content.subarray(12, 16).toString('ascii');
  if (!WEBP_CHUNK_TYPES.has(chunkType)) return false;

  const chunkSize = content.readUInt32LE(16);
  const paddedChunkSize = chunkSize + (chunkSize % 2);
  if (20 + paddedChunkSize > content.length) return false;
  if (chunkType === 'VP8X') return chunkSize === 10;
  if (chunkType === 'VP8L') return chunkSize >= 5;
  return chunkSize >= 10;
};

export const detectInvoiceDocumentContentType = (value) => {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);

  if (startsWith(content, PDF_MAGIC) && hasPdfEof(content)) {
    return 'application/pdf';
  }
  if (hasValidJpegStructure(content)) {
    return 'image/jpeg';
  }
  if (hasValidPngStructure(content)) {
    return 'image/png';
  }
  if (hasValidWebpStructure(content)) {
    return 'image/webp';
  }

  return null;
};

export const sanitizeInvoiceDocumentFilename = (value) => {
  const filename = String(value)
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();

  if (!filename || filename === '.' || filename === '..') {
    throw createDomainError(
      400,
      'INVOICE_DOCUMENT_FILENAME_INVALID',
      'Indica un nombre de archivo válido.',
    );
  }

  return filename;
};

export const canonicalizeInvoiceDocumentFilename = (value, contentType) => {
  const extension = CANONICAL_EXTENSIONS[contentType];
  if (!extension) {
    throw createDomainError(
      415,
      'INVOICE_DOCUMENT_CONTENT_TYPE_UNSUPPORTED',
      'Solo se admiten archivos PDF, JPEG, PNG o WebP.',
    );
  }

  const filename = sanitizeInvoiceDocumentFilename(value);
  const extensionIndex = filename.lastIndexOf('.');
  const untrimmedStem =
    extensionIndex > 0
      ? filename.slice(0, extensionIndex)
      : extensionIndex === 0
        ? ''
        : filename;
  const stem = untrimmedStem.replace(/^[.\s]+|[.\s]+$/gu, '') || 'document';
  const maximumStemLength = 255 - extension.length;
  const truncatedStem =
    [...stem]
      .slice(0, maximumStemLength)
      .join('')
      .replace(/[.\s]+$/gu, '') || 'document';

  return `${truncatedStem}${extension}`;
};

export const decodeInvoiceDocumentFilenameHeader = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw createDomainError(
      400,
      'INVOICE_DOCUMENT_FILENAME_INVALID',
      'Envía un nombre de archivo codificado válido.',
    );
  }

  try {
    return sanitizeInvoiceDocumentFilename(decodeURIComponent(value));
  } catch (error) {
    if (error?.code === 'INVOICE_DOCUMENT_FILENAME_INVALID') throw error;
    throw createDomainError(
      400,
      'INVOICE_DOCUMENT_FILENAME_INVALID',
      'Envía un nombre de archivo codificado válido.',
    );
  }
};

const encodeRfc5987 = (value) =>
  encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  );

export const attachmentContentDisposition = (filename) => {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');

  return `attachment; filename="${fallback || 'document'}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
};

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
