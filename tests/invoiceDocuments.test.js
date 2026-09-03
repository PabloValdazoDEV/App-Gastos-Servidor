import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createFinanceRouter } from '../src/modules/finance/index.js';
import {
  attachmentContentDisposition,
  canonicalizeInvoiceDocumentFilename,
  decodeInvoiceDocumentFilenameHeader,
  detectInvoiceDocumentContentType,
  mapInvoiceDocumentBodyError,
  MAX_INVOICE_DOCUMENT_SIZE_BYTES,
  sanitizeInvoiceDocumentFilename,
} from '../src/modules/finance/invoiceDocuments.js';

const householdId = '30000000-0000-4000-8000-000000000001';
const otherHouseholdId = '30000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';
const invoiceId = '30000000-0000-4000-8000-000000000004';
const otherInvoiceId = '30000000-0000-4000-8000-000000000005';
const documentId = '30000000-0000-4000-8000-000000000006';

const pdf = Buffer.from('%PDF-1.7\ninvoice\n%%EOF', 'ascii');
const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
  0x00, 0x3f, 0x00, 0x00,
  0xff, 0xd9,
]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x16, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8X', 'ascii'),
  Buffer.from([0x0a, 0x00, 0x00, 0x00]),
  Buffer.alloc(10),
]);

const metadataFor = (document) => ({
  id: document.id,
  invoiceId: document.invoiceId,
  filename: document.filename,
  contentType: document.contentType,
  sizeBytes: document.sizeBytes,
  uploadedByUserId: document.uploadedByUserId,
  uploadedBy: document.uploadedBy,
  createdAt: document.createdAt,
});

const createFixture = () => {
  const invoices = [
    {
      id: invoiceId,
      householdId,
      categoryId: '30000000-0000-4000-8000-000000000007',
      amountCents: 10_000,
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      invoiceDate: new Date('2026-08-02T00:00:00.000Z'),
      category: { id: '30000000-0000-4000-8000-000000000007' },
    },
    {
      id: otherInvoiceId,
      householdId,
      categoryId: '30000000-0000-4000-8000-000000000007',
      amountCents: 20_000,
      periodEnd: new Date('2026-07-01T00:00:00.000Z'),
      invoiceDate: new Date('2026-07-02T00:00:00.000Z'),
      category: { id: '30000000-0000-4000-8000-000000000007' },
    },
  ];
  const documents = [];
  let nextDocument = 10;

  const addDocument = ({
    id = `30000000-0000-4000-8000-${String(nextDocument).padStart(12, '0')}`,
    targetInvoiceId = invoiceId,
    filename = 'factura.pdf',
    contentType = 'application/pdf',
    content = pdf,
  } = {}) => {
    nextDocument += 1;
    const document = {
      id,
      invoiceId: targetInvoiceId,
      uploadedByUserId: userId,
      filename,
      contentType,
      sizeBytes: content.length,
      content: Buffer.from(content),
      uploadedBy: { id: userId, name: 'Persona que subió' },
      createdAt: new Date('2026-08-26T12:00:00.000Z'),
    };
    documents.push(document);
    return document;
  };

  const invoiceDocument = {
    count: vi.fn(({ where }) =>
      Promise.resolve(
        documents.filter((item) => item.invoiceId === where.invoiceId).length,
      ),
    ),
    create: vi.fn(({ data }) =>
      Promise.resolve(
        metadataFor(
          addDocument({
            ...data,
            id: `30000000-0000-4000-8000-${String(nextDocument).padStart(12, '0')}`,
            targetInvoiceId: data.invoiceId,
          }),
        ),
      ),
    ),
    findMany: vi.fn(({ where }) =>
      Promise.resolve(
        documents
          .filter((item) => item.invoiceId === where.invoiceId)
          .map(metadataFor),
      ),
    ),
    findFirst: vi.fn(({ where }) => {
      const document = documents.find(
        (item) => item.id === where.id && item.invoiceId === where.invoiceId,
      );
      return Promise.resolve(document ? { ...document } : null);
    }),
    deleteMany: vi.fn(({ where }) => {
      const index = documents.findIndex(
        (item) => item.id === where.id && item.invoiceId === where.invoiceId,
      );
      if (index === -1) return Promise.resolve({ count: 0 });
      documents.splice(index, 1);
      return Promise.resolve({ count: 1 });
    }),
  };
  const auditLog = { create: vi.fn(() => Promise.resolve({ id: crypto.randomUUID() })) };
  const database = { auditLog, invoiceDocument };
  const prisma = {
    ...database,
    householdUserAccess: {
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(
          where.householdId === householdId
            ? {
                role: 'MEMBER',
                household: {
                  id: householdId,
                  isActive: true,
                  ownerUserId: null,
                },
              }
            : null,
        ),
      ),
    },
    utilityInvoice: {
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(
          invoices.find(
            (invoice) =>
              invoice.id === where.id && invoice.householdId === where.householdId,
          ) ?? null,
        ),
      ),
      findMany: vi.fn(() =>
        Promise.resolve(
          invoices.map((invoice) => ({
            ...invoice,
            _count: {
              documents: documents.filter(
                (document) => document.invoiceId === invoice.id,
              ).length,
            },
          })),
        ),
      ),
    },
    $transaction: vi.fn((operation) => operation(database)),
  };
  const authenticate = (request_, response, next) => {
    if (request_.get('authorization') !== 'Bearer test') {
      response.status(401).json({ success: false, code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    request_.auth = { userId, sessionId: crypto.randomUUID() };
    next();
  };
  const requireCsrf = (request_, response, next) => {
    if (request_.get('x-csrf-token') !== 'test-csrf') {
      response.status(403).json({ success: false, code: 'CSRF_TOKEN_INVALID' });
      return;
    }
    next();
  };
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(
    '/api',
    createFinanceRouter({ prisma, authenticate, requireCsrf }),
  );
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? 400).json({
      success: false,
      code: error.code ?? 'VALIDATION_ERROR',
      message: error.message,
    });
  });

  const collectionPath = `/api/households/${householdId}/invoices/${invoiceId}/documents`;
  const authenticated = (request_) => request_.set('Authorization', 'Bearer test');
  const mutable = (request_) =>
    authenticated(request_).set('X-CSRF-Token', 'test-csrf');
  const named = (request_, filename) =>
    request_.set('X-Document-Filename', encodeURIComponent(filename));

  return {
    addDocument,
    app,
    auditLog,
    collectionPath,
    documents,
    invoiceDocument,
    mutable,
    named,
    authenticated,
    prisma,
  };
};

describe('invoice documents', () => {
  it.each([
    ['application/pdf', pdf, '.pdf'],
    ['image/jpeg', jpeg, '.jpg'],
    ['image/png', png, '.png'],
    ['image/webp', webp, '.webp'],
  ])('detects and accepts a real %s signature', async (contentType, content, extension) => {
    const fixture = createFixture();
    const canonicalFilename = `Factura á${extension}`;

    expect(detectInvoiceDocumentContentType(content)).toBe(contentType);
    const response = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', contentType),
      )
      .set(
        'X-Document-Filename',
        encodeURIComponent('../carpeta/Factura á.ext'),
      )
      .send(content)
      .expect(201);

    expect(response.body.data).toMatchObject({
      invoiceId,
      filename: canonicalFilename,
      contentType,
      sizeBytes: content.length,
      uploadedByUserId: userId,
      uploadedBy: { id: userId, name: 'Persona que subió' },
    });
    expect(response.body.data).not.toHaveProperty('content');
    expect(fixture.documents[0].content.equals(content)).toBe(true);
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(fixture.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'EXPENSE_CHANGED',
        resourceType: 'InvoiceDocument',
        metadata: expect.objectContaining({ operation: 'UPLOAD' }),
      }),
    });
    expect(JSON.stringify(fixture.auditLog.create.mock.calls)).not.toContain(
      'Factura á.ext',
    );

    const download = await fixture
      .authenticated(
        request(fixture.app).get(
          `${fixture.collectionPath}/${response.body.data.id}/content`,
        ),
      )
      .expect(200);
    expect(download.headers['content-disposition']).toBe(
      attachmentContentDisposition(canonicalFilename),
    );
  });

  it('rejects truncated containers even when their leading magic bytes match', () => {
    expect(
      detectInvoiceDocumentContentType(Buffer.from('%PDF-1.7\nmissing eof')),
    ).toBeNull();
    expect(
      detectInvoiceDocumentContentType(Buffer.from([0xff, 0xd8, 0xff, 0x00])),
    ).toBeNull();
    expect(detectInvoiceDocumentContentType(png.subarray(0, 8))).toBeNull();

    const jpegWithoutSof = Buffer.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
      0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(detectInvoiceDocumentContentType(jpegWithoutSof)).toBeNull();

    const pngWithoutIhdr = Buffer.concat([png.subarray(0, 8), png.subarray(-12)]);
    expect(detectInvoiceDocumentContentType(pngWithoutIhdr)).toBeNull();
    const zeroWidthPng = Buffer.from(png);
    zeroWidthPng.writeUInt32BE(0, 16);
    expect(detectInvoiceDocumentContentType(zeroWidthPng)).toBeNull();

    const wrongLengthWebp = Buffer.from(webp);
    wrongLengthWebp.writeUInt32LE(999, 4);
    expect(detectInvoiceDocumentContentType(wrongLengthWebp)).toBeNull();
    const incompleteChunkWebp = Buffer.from(webp.subarray(0, -1));
    incompleteChunkWebp.writeUInt32LE(incompleteChunkWebp.length - 8, 4);
    expect(detectInvoiceDocumentContentType(incompleteChunkWebp)).toBeNull();
  });

  it('lists metadata and exposes only a count in the invoice list', async () => {
    const fixture = createFixture();
    fixture.addDocument({ id: documentId });

    const list = await fixture
      .authenticated(request(fixture.app).get(fixture.collectionPath))
      .expect(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: documentId, filename: 'factura.pdf' }),
    ]);
    expect(list.body.data[0]).not.toHaveProperty('content');
    expect(fixture.invoiceDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ content: true }),
      }),
    );

    const invoices = await fixture
      .authenticated(
        request(fixture.app).get(`/api/households/${householdId}/invoices`),
      )
      .expect(200);
    expect(invoices.body.data[0].documentCount).toBe(1);
    expect(invoices.body.data[0]).not.toHaveProperty('documents');
    expect(invoices.body.data[0]).not.toHaveProperty('_count');
    expect(fixture.prisma.utilityInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: { select: { documents: true } },
        }),
      }),
    );
  });

  it('serves untrusted content as an attachment with restrictive headers', async () => {
    const fixture = createFixture();
    fixture.addDocument({ id: documentId, filename: 'Factura á.pdf' });
    const response = await fixture
      .authenticated(
        request(fixture.app).get(
          `${fixture.collectionPath}/${documentId}/content`,
        ),
      )
      .expect(200);

    expect(response.headers['content-type']).toMatch(/^application\/pdf/);
    expect(response.headers['content-length']).toBe(String(pdf.length));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['content-disposition']).toBe(
      attachmentContentDisposition('Factura á.pdf'),
    );
    expect(Buffer.from(response.body).equals(pdf)).toBe(true);
  });

  it('deletes only a document scoped to its invoice and requires CSRF', async () => {
    const fixture = createFixture();
    fixture.addDocument({ id: documentId });

    await fixture
      .authenticated(
        request(fixture.app).delete(`${fixture.collectionPath}/${documentId}`),
      )
      .expect(403);
    const deleted = await fixture
      .mutable(
        request(fixture.app).delete(`${fixture.collectionPath}/${documentId}`),
      )
      .expect(200);

    expect(deleted.body.data).toEqual({ id: documentId, deleted: true });
    expect(fixture.documents).toHaveLength(0);
    expect(fixture.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ operation: 'DELETE', documentId }),
      }),
    });
  });

  it('does not expose a document through another invoice or household', async () => {
    const fixture = createFixture();
    fixture.addDocument({ id: documentId });

    const otherInvoicePath = `/api/households/${householdId}/invoices/${otherInvoiceId}/documents/${documentId}/content`;
    const hiddenDocument = await fixture
      .authenticated(request(fixture.app).get(otherInvoicePath))
      .expect(404);
    expect(hiddenDocument.body.code).toBe('INVOICE_DOCUMENT_NOT_FOUND');

    const otherHouseholdPath = `/api/households/${otherHouseholdId}/invoices/${invoiceId}/documents/${documentId}/content`;
    const hiddenHousehold = await fixture
      .authenticated(request(fixture.app).get(otherHouseholdPath))
      .expect(404);
    expect(hiddenHousehold.body.code).toBe('HOUSEHOLD_NOT_FOUND');
  });

  it('rejects unsupported, empty, mismatched, and oversized content', async () => {
    const fixture = createFixture();

    const missingFilename = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'application/pdf'),
      )
      .send(pdf)
      .expect(400);
    expect(missingFilename.body.code).toBe(
      'INVOICE_DOCUMENT_FILENAME_INVALID',
    );

    const unsupported = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'text/plain'),
      )
      .set('X-Document-Filename', encodeURIComponent('factura.txt'))
      .send('not allowed')
      .expect(415);
    expect(unsupported.body.code).toBe(
      'INVOICE_DOCUMENT_CONTENT_TYPE_UNSUPPORTED',
    );

    const empty = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'application/pdf'),
      )
      .set('X-Document-Filename', encodeURIComponent('empty.pdf'))
      .send(Buffer.alloc(0))
      .expect(400);
    expect(empty.body.code).toBe('INVOICE_DOCUMENT_EMPTY');

    const mismatched = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'image/jpeg'),
      )
      .set('X-Document-Filename', encodeURIComponent('fake.jpg'))
      .send(pdf)
      .expect(415);
    expect(mismatched.body.code).toBe('INVOICE_DOCUMENT_SIGNATURE_INVALID');

    const oversizedContent = Buffer.alloc(
      MAX_INVOICE_DOCUMENT_SIZE_BYTES + 1,
      0,
    );
    pdf.copy(oversizedContent);
    const oversized = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'application/pdf'),
      )
      .set('X-Document-Filename', encodeURIComponent('large.pdf'))
      .send(oversizedContent)
      .expect(413);
    expect(oversized.body.code).toBe('INVOICE_DOCUMENT_TOO_LARGE');
  });

  it('enforces five documents and never attempts a sixth insert', async () => {
    const fixture = createFixture();
    for (let index = 0; index < 5; index += 1) fixture.addDocument();

    const response = await fixture
      .mutable(
        request(fixture.app)
          .post(fixture.collectionPath)
          .set('Content-Type', 'application/pdf'),
      )
      .set('X-Document-Filename', encodeURIComponent('sixth.pdf'))
      .send(pdf)
      .expect(409);

    expect(response.body.code).toBe('INVOICE_DOCUMENT_LIMIT_REACHED');
    expect(fixture.invoiceDocument.create).not.toHaveBeenCalled();
    expect(fixture.documents).toHaveLength(5);
  });

  it('sanitizes names and replaces hostile extensions with the validated type', () => {
    expect(sanitizeInvoiceDocumentFilename('../folder/invoice.pdf')).toBe(
      'invoice.pdf',
    );
    expect(sanitizeInvoiceDocumentFilename('folder\\safe\u202E.pdf')).toBe(
      'safe.pdf',
    );
    expect(() => sanitizeInvoiceDocumentFilename('../..')).toThrow(
      'nombre de archivo válido',
    );
    expect(
      canonicalizeInvoiceDocumentFilename('page.html', 'application/pdf'),
    ).toBe('page.pdf');
    expect(
      canonicalizeInvoiceDocumentFilename('vector.svg', 'image/jpeg'),
    ).toBe('vector.jpg');
    expect(
      canonicalizeInvoiceDocumentFilename('program.exe', 'image/png'),
    ).toBe('program.png');
    expect(
      canonicalizeInvoiceDocumentFilename('.exe', 'application/pdf'),
    ).toBe('document.pdf');
    const longCanonicalName = canonicalizeInvoiceDocumentFilename(
      `${'😀'.repeat(300)}.html`,
      'image/webp',
    );
    expect([...longCanonicalName]).toHaveLength(255);
    expect(longCanonicalName.endsWith('.webp')).toBe(true);
    expect(
      decodeInvoiceDocumentFilenameHeader(
        encodeURIComponent('../folder/Factura á.pdf'),
      ),
    ).toBe('Factura á.pdf');
    expect(() => decodeInvoiceDocumentFilenameHeader('%not-valid')).toThrow(
      'nombre de archivo codificado válido',
    );
    expect(() => decodeInvoiceDocumentFilenameHeader(undefined)).toThrow(
      'nombre de archivo codificado válido',
    );
  });

  it('normalizes interrupted and malformed raw uploads to stable 400 errors', () => {
    expect(mapInvoiceDocumentBodyError({ type: 'request.aborted', status: 400 }))
      .toMatchObject({ statusCode: 400, code: 'INVOICE_DOCUMENT_UPLOAD_INVALID' });
    expect(
      mapInvoiceDocumentBodyError({ type: 'request.size.invalid', status: 400 }),
    ).toMatchObject({
      statusCode: 400,
      code: 'INVOICE_DOCUMENT_UPLOAD_INVALID',
    });
    expect(mapInvoiceDocumentBodyError({ type: 'stream.failure', status: 422 }))
      .toMatchObject({ statusCode: 400, code: 'INVOICE_DOCUMENT_UPLOAD_INVALID' });
    expect(
      mapInvoiceDocumentBodyError({
        type: 'stream.failure',
        statusCode: 409,
      }),
    ).toMatchObject({
      statusCode: 400,
      code: 'INVOICE_DOCUMENT_UPLOAD_INVALID',
    });
  });

  it('requires authentication before any document operation', async () => {
    const fixture = createFixture();

    await request(fixture.app).get(fixture.collectionPath).expect(401);
    expect(fixture.prisma.householdUserAccess.findFirst).not.toHaveBeenCalled();
  });
});
