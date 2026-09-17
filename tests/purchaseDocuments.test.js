import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { MAX_INVOICE_DOCUMENT_SIZE_BYTES } from '../src/modules/finance/invoiceDocuments.js';
import { mapPurchaseDocumentBodyError, MAX_PURCHASE_DOCUMENT_SIZE_BYTES, validatePurchaseDocumentContent } from '../src/modules/purchases/purchaseDocuments.js';
import { authenticated, collectBinary, documentBodies, documentsTestApp, mutable, supportedDocuments, upload } from './helpers/purchaseDocumentsFixtures.js';

const householdId = '70000000-0000-4000-8000-000000000001';
const purchaseId = '70000000-0000-4000-8000-000000000002';
const userId = '70000000-0000-4000-8000-000000000003';
const itemId = '70000000-0000-4000-8000-000000000004';
const documentId = '70000000-0000-4000-8000-000000000005';
const path = `/api/households/${householdId}/purchases/${purchaseId}/documents`;

function fixture({ visible = true } = {}) {
  const records = new Map();
  const bytes = new Map();
  const purchase = { id: purchaseId, householdId, ownershipType: 'HOUSEHOLD', archivedAt: null, items: [{ id: itemId, purchaseId }], personalPerson: null, shares: [] };
  const timestamps = { createdAt: new Date('2026-09-17T10:00:00Z'), updatedAt: new Date('2026-09-17T10:00:00Z') };
  const metadata = (record) => record ? { ...record, uploadedBy: { id: userId, name: 'Pablo' } } : null;
  const find = ({ where }) => metadata([...records.values()].find((row) => row.id === where.id && (!where.purchaseId || row.purchaseId === where.purchaseId)));
  const remove = ({ where }) => { const record = records.get(where.id); records.delete(where.id); return metadata(record); };
  const prisma = {
    householdUserAccess: { findFirst: vi.fn(async () => ({ role: 'MEMBER', household: { id: householdId, timezone: 'Europe/Madrid', isActive: true } })) },
    purchase: { findFirst: vi.fn(async () => visible ? purchase : null), update: vi.fn(async () => purchase) },
    purchaseItem: { findFirst: vi.fn(async ({ where }) => where.id === itemId && where.purchaseId === purchaseId ? purchase.items[0] : null) },
    purchaseDocument: {
      create: vi.fn(async ({ data }) => {
        const record = { id: documentId, ...timestamps, purchaseItemId: null, ...data };
        records.set(record.id, record);
        return metadata(record);
      }),
      findMany: vi.fn(async () => [...records.values()].map(metadata)),
      findFirst: vi.fn(async (query) => find(query)),
      findUnique: vi.fn(async (query) => find(query)),
      update: vi.fn(async ({ where, data }) => { const record = { ...records.get(where.id), ...data }; records.set(where.id, record); return metadata(record); }),
      delete: vi.fn(async (query) => remove(query)),
      deleteMany: vi.fn(async (query) => ({ count: remove(query) ? 1 : 0 })),
    },
    auditLog: { create: vi.fn(async ({ data }) => ({ id: crypto.randomUUID(), ...data })) },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  const storage = {
    save: vi.fn(async (_database, { documentId: id, content }) => { bytes.set(id, Buffer.from(content)); }),
    get: vi.fn(async (_database, { documentId: id }) => bytes.get(id) ?? null),
    delete: vi.fn(async (_database, { documentId: id }) => { bytes.delete(id); }),
  };
  const app = documentsTestApp(prisma, { documentStorage: storage });
  return { app, prisma, storage, records, bytes, purchase };
}

describe('purchase document HTTP validation and private transport', () => {
  it.each(supportedDocuments)('accepts %s with validated signature through injectable storage', async (contentType, content, extension) => {
    const { app, prisma, storage, bytes } = fixture();
    const { body } = await upload(app, path, userId, { contentType, content, filename: '../folder/Documento á.exe' }).expect(201);
    expect(body.data).toMatchObject({ purchaseId, purchaseItemId: null, type: 'RECEIPT', filename: `Documento á${extension}`, contentType, sizeBytes: content.length });
    expect(body.data).not.toHaveProperty('content');
    expect(body.data).not.toHaveProperty('url');
    expect(bytes.get(body.data.id)).toEqual(content);
    expect(storage.save).toHaveBeenCalledWith(prisma, { documentId: body.data.id, content });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    const result = await authenticated(request(app).get(`${path}/${body.data.id}/content`), userId).buffer(true).parse(collectBinary).expect(200);
    expect(result.body).toEqual(content);
    expect(result.headers['content-type']).toBe(contentType);
    expect(result.headers['content-length']).toBe(String(content.length));
    expect(result.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(result.headers['content-disposition']).toContain("filename*=UTF-8''Documento%20%C3%A1");
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-security-policy']).toContain('sandbox');
  });

  it.each(['text/html', 'application/javascript', 'image/svg+xml', 'application/zip', 'application/octet-stream'])('rejects forbidden MIME %s before storage', async (contentType) => {
    const { app, storage } = fixture();
    await upload(app, path, userId, { contentType }).expect(415);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it.each([
    ['PDF spoof', 'application/pdf', Buffer.from('<html>not a PDF</html>')],
    ['MIME mismatch', 'image/png', documentBodies.jpeg],
    ['truncated PDF', 'application/pdf', Buffer.from('%PDF-1.7\nno eof')],
    ['truncated JPEG', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['truncated PNG', 'image/png', documentBodies.png.subarray(0, 8)],
    ['truncated WebP', 'image/webp', documentBodies.webp.subarray(0, 12)],
  ])('rejects %s', async (_name, contentType, content) => {
    const { app, storage } = fixture();
    await upload(app, path, userId, { contentType, content }).expect(415);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('rejects an empty file and size above the centralized ten MiB limit', async () => {
    const { app, storage } = fixture();
    await upload(app, path, userId, { content: Buffer.alloc(0) }).expect(400);
    expect(MAX_INVOICE_DOCUMENT_SIZE_BYTES).toBe(10_485_760);
    const oversized = await upload(app, path, userId, { content: Buffer.alloc(MAX_INVOICE_DOCUMENT_SIZE_BYTES + 1) }).expect(413);
    expect(oversized.body.message).toMatch(/tamaño|MiB|máximo/i);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('accepts exactly the central size boundary and shares it with the existing invoice mechanism', () => {
    expect(MAX_PURCHASE_DOCUMENT_SIZE_BYTES).toBe(MAX_INVOICE_DOCUMENT_SIZE_BYTES);
    const exact = Buffer.alloc(MAX_PURCHASE_DOCUMENT_SIZE_BYTES, 0x20);
    documentBodies.pdf.copy(exact);
    exact.write('%%EOF', exact.length - 5, 'ascii');
    expect(() => validatePurchaseDocumentContent(exact, 'application/pdf')).not.toThrow();
    expect(() => validatePurchaseDocumentContent(Buffer.concat([exact, Buffer.from(' ')]), 'application/pdf')).toThrow('tamaño máximo');
  });
  it.each([
    [{ type: 'entity.too.large' }, 413, 'PURCHASE_DOCUMENT_TOO_LARGE'],
    [{ type: 'encoding.unsupported' }, 415, 'PURCHASE_DOCUMENT_CONTENT_ENCODING_UNSUPPORTED'],
    [{ type: 'request.aborted', status: 400 }, 400, 'PURCHASE_DOCUMENT_UPLOAD_INVALID'],
    [{ type: 'request.size.invalid', status: 400 }, 400, 'PURCHASE_DOCUMENT_UPLOAD_INVALID'],
    [{ type: 'stream.failure', status: 422 }, 400, 'PURCHASE_DOCUMENT_UPLOAD_INVALID'],
  ])('normalizes raw upload failure %j', (failure, statusCode, code) => expect(mapPurchaseDocumentBodyError(failure)).toMatchObject({ statusCode, code }));
  it('does not hide internal parser exceptions or invent an error for successful parsing', () => {
    const failure = new Error('Unexpected internal error');
    expect(mapPurchaseDocumentBodyError(failure)).toBe(failure);
    expect(mapPurchaseDocumentBodyError(undefined)).toBeUndefined();
  });
  it('rejects transport compression instead of inflating attacker data', async () => {
    const { app, storage } = fixture();
    await upload(app, path, userId).set('Content-Encoding', 'gzip').expect(415);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it.each([undefined, '%bad-percent', encodeURIComponent('../..')])('rejects missing or invalid filename header %s', async (filename) => {
    const { app, storage } = fixture();
    let operation = mutable(request(app).post(path), userId).set('Content-Type', 'application/pdf');
    if (filename !== undefined) operation = operation.set('X-Document-Filename', filename);
    await operation.send(documentBodies.pdf).expect(400);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('sanitizes filename traversal, controls and unsafe extension and safely quotes download headers', async () => {
    const { app } = fixture();
    const filename = '..\\folder\\Factura "á\r\nX-Evil: injected\u202E.html';
    const { body } = await upload(app, path, userId, { filename }).expect(201);
    expect(body.data.filename).toBe('Factura "áX-Evil: injected.pdf');
    const result = await authenticated(request(app).get(`${path}/${body.data.id}/content?disposition=inline`), userId).expect(200);
    expect(result.headers['content-disposition']).toMatch(/^inline; filename="/);
    expect(result.headers).not.toHaveProperty('x-evil');
    expect(result.headers['content-disposition']).not.toMatch(/[\r\n]/);
    expect(result.headers['content-disposition']).not.toContain('../');
  });
  it('limits Unicode filenames to 255 characters and keeps safe extension', async () => {
    const { app } = fixture();
    const { body } = await upload(app, path, userId, { filename: `${'á'.repeat(300)}.exe` }).expect(201);
    expect([...body.data.filename]).toHaveLength(255);
    expect(body.data.filename.endsWith('.pdf')).toBe(true);
  });
  it.each([
    ['get', ''], ['post', ''], ['get', `/${documentId}/content`], ['patch', `/${documentId}`], ['delete', `/${documentId}`],
  ])('requires authentication for %s %s before querying private data', async (method, suffix) => {
    const { app, prisma, storage } = fixture();
    await request(app)[method](`${path}${suffix}`).expect(401);
    expect(prisma.householdUserAccess.findFirst).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });
  it.each([['post', ''], ['patch', `/${documentId}`], ['delete', `/${documentId}`]])('requires CSRF for %s before storage', async (method, suffix) => {
    const { app, storage } = fixture();
    await authenticated(request(app)[method](`${path}${suffix}`), userId).expect(403);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('fails authorization before validating or saving raw bytes of an invisible purchase', async () => {
    const { app, storage } = fixture({ visible: false });
    await upload(app, path, userId, { content: Buffer.from('bad') }).expect(404);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('rechecks purchase authorization inside upload transaction after reading the request body', async () => {
    const { app, prisma, storage, purchase } = fixture();
    prisma.purchase.findFirst.mockResolvedValueOnce(purchase).mockResolvedValue(null);
    await upload(app, path, userId).expect(404);
    expect(prisma.purchase.findFirst).toHaveBeenCalledTimes(2);
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.purchaseDocument.create).not.toHaveBeenCalled();
  });
  it.each(['get', 'patch', 'delete'])('rechecks authorization inside %s transaction before accessing storage', async (method) => {
    const { app, prisma, storage, purchase } = fixture();
    await upload(app, path, userId).expect(201);
    prisma.purchase.findFirst.mockClear().mockResolvedValueOnce(purchase).mockResolvedValue(null);
    const suffix = method === 'get' ? '/content' : '';
    const operation = mutable(request(app)[method](`${path}/${documentId}${suffix}`), userId);
    await (method === 'patch' ? operation.send({ type: 'OTHER' }) : operation).expect(404);
    expect(prisma.purchase.findFirst).toHaveBeenCalledTimes(2);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('rechecks list authorization in the same transaction that reads metadata', async () => {
    const { app, prisma, purchase } = fixture();
    prisma.purchase.findFirst.mockResolvedValueOnce(purchase).mockResolvedValue(null);
    await authenticated(request(app).get(path), userId).expect(404);
    expect(prisma.purchaseDocument.findMany).not.toHaveBeenCalled();
  });
  it('storage serialization conflicts remain retryable rather than becoming permanent storage failures', async () => {
    const { app, prisma, storage } = fixture();
    storage.save.mockRejectedValueOnce(Object.assign(new Error('Synthetic serializable conflict'), { code: 'P2034' }));
    await upload(app, path, userId).expect(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each([{ type: 'UNKNOWN' }, { purchaseItemId: 'not-a-uuid' }, { type: 'RECEIPT', ownershipType: 'HOUSEHOLD' }])('rejects invalid upload metadata %j', async (query) => {
    const { app, storage } = fixture();
    await upload(app, path, userId, { query }).expect(400);
    expect(storage.save).not.toHaveBeenCalled();
  });
  it('defaults type OTHER and rejects download query injection or unsupported disposition', async () => {
    const { app, storage } = fixture();
    const { body } = await upload(app, path, userId, { query: {} }).expect(201);
    expect(body.data.type).toBe('OTHER');
    for (const query of [{ disposition: 'public' }, { disposition: 'inline\r\nX-Evil: yes' }, { unknown: 'field' }]) {
      await authenticated(request(app).get(`${path}/${body.data.id}/content`).query(query), userId).expect(400);
    }
    expect(storage.get).not.toHaveBeenCalled();
  });
  it.each([{ content: 'binary' }, { filename: 'new.pdf' }, { contentType: 'text/html' }, { storageKey: '/tmp/private' }, {}])('PATCH only accepts type or product, not %j', async (input) => {
    const { app } = fixture();
    const { body } = await upload(app, path, userId).expect(201);
    await mutable(request(app).patch(`${path}/${body.data.id}`), userId).send(input).expect(400);
  });
  it('PATCH rejects raw binary bodies rather than replacing the stored file', async () => {
    const { app, bytes } = fixture();
    await upload(app, path, userId).expect(201);
    await mutable(request(app).patch(`${path}/${documentId}`), userId).set('Content-Type', 'application/pdf').send(documentBodies.pdf).expect(400);
    expect(bytes.get(documentId)).toEqual(documentBodies.pdf);
  });
  it.each([null, Buffer.from('wrong size')])('missing or inconsistent binary returns an actionable failure, never empty success (%s)', async (stored) => {
    const { app, storage } = fixture();
    await upload(app, path, userId).expect(201);
    storage.get.mockResolvedValue(stored);
    const result = await authenticated(request(app).get(`${path}/${documentId}/content`), userId).expect(503);
    expect(result.body.code).toBe('PURCHASE_DOCUMENT_STORAGE_UNAVAILABLE');
  });
  it('list never embeds binary content or public storage URLs and audit excludes filenames/bytes', async () => {
    const { app, prisma, storage } = fixture();
    await upload(app, path, userId).expect(201);
    const { body } = await authenticated(request(app).get(path), userId).expect(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('content');
    expect(body.data[0]).not.toHaveProperty('storageKey');
    expect(JSON.stringify(body.data)).not.toContain('private purchase document');
    expect(JSON.stringify(body.data)).not.toContain('base64');
    expect(storage.get).not.toHaveBeenCalled();
    const auditCalls = JSON.stringify(prisma.auditLog.create.mock.calls);
    expect(auditCalls).not.toContain('Ticket.pdf');
    expect(auditCalls).not.toContain('private purchase document');
  });
});
