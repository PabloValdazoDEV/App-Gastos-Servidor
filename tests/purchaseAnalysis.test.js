import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ReceiptAnalysisError } from '../src/services/receiptAnalyzer.js';
import { analyzePurchaseDocumentSchema, confirmPurchaseAnalysisSchema, reviewedPurchaseTotalMismatch } from '../src/modules/purchases/purchaseAnalysis.schemas.js';
import { purchaseAnalysisVersion } from '../src/modules/purchases/purchaseAnalysis.service.js';
import { analysisTestApp, makeReceiptAnalyzer, receiptData, receiptResult, reviewedBody } from './helpers/purchaseAnalysisFixtures.js';
import { authenticated as auth, mutable as write, documentBodies, supportedDocuments } from './helpers/purchaseDocumentsFixtures.js';

const householdId = '81000000-0000-4000-8000-000000000001';
const purchaseId = '81000000-0000-4000-8000-000000000002';
const userId = '81000000-0000-4000-8000-000000000003';
const documentId = '81000000-0000-4000-8000-000000000004';
const path = `/api/households/${householdId}/purchases/${purchaseId}/documents/${documentId}`;

function fixture(options = {}) {
  const records = [];
  const purchase = { id: purchaseId, householdId, merchant: 'Original', totalCents: 1000, purchaseDate: new Date('2026-09-17'), updatedAt: new Date(), ownershipType: 'HOUSEHOLD', archivedAt: null, shares: [], items: [] };
  const document = { id: documentId, purchaseId, contentType: 'application/pdf', sizeBytes: documentBodies.pdf.length, filename: 'Privado.pdf' };
  const state = { visible: true, member: true, document: true, insideTransaction: false };
  const prisma = {
    householdUserAccess: { findFirst: vi.fn(async () => state.member ? { role: 'MEMBER', household: { id: householdId, timezone: 'Europe/Madrid', currency: 'EUR', isActive: true } } : null) },
    purchase: { findFirst: vi.fn(async () => state.visible ? purchase : null), update: vi.fn() },
    purchaseDocument: { findFirst: vi.fn(async ({ where }) => state.document && where.id === documentId && where.purchaseId === purchaseId ? document : null) },
    purchaseDocumentAnalysis: {
      create: vi.fn(async ({ data }) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), confirmedAt: null, confirmedByUserId: null, ...data };
        if (row.status === 'FAILED') row.extractedData = null;
        row.reviewedData = null; records.push(row); return row;
      }),
      findMany: vi.fn(async () => [...records].reverse()),
      findFirst: vi.fn(async ({ where }) => records.find((row) => row.id === where.id && row.purchaseDocumentId === where.purchaseDocumentId)),
    },
    auditLog: { create: vi.fn(async ({ data }) => data) },
  };
  prisma.$transaction = vi.fn(async (callback) => {
    state.insideTransaction = true;
    try { return await callback(prisma); } finally { state.insideTransaction = false; }
  });
  const storage = { get: vi.fn(async () => documentBodies.pdf), save: vi.fn(), delete: vi.fn() };
  const analyzer = options.receiptAnalyzer ?? makeReceiptAnalyzer();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const app = analysisTestApp(prisma, { receiptAnalyzer: analyzer, documentStorage: storage, aiConfig: options.aiConfig, logger });
  const analyze = () => write(request(app).post(`${path}/analyze`), userId).send({ consent: true });
  return { app, prisma, state, purchase, document, records, storage, analyzer, logger, analyze };
}

describe('purchase document analysis authenticated HTTP', () => {
  it.each(supportedDocuments)('analyzes %s privately with one provider call outside transactions and no purchase write', async (contentType, content) => {
    const ctx = fixture(); Object.assign(ctx.document, { contentType, sizeBytes: content.length });
    ctx.storage.get.mockResolvedValue(content);
    ctx.analyzer.analyze.mockImplementation(async () => { expect(ctx.state.insideTransaction).toBe(false); return receiptResult; });
    const result = await ctx.analyze().expect(201);
    expect(result.body.data).toMatchObject({ status: 'COMPLETED', extractedData: receiptData, inputTokens: 100, outputTokens: 50, totalTokens: 150, model: 'test-receipt-model' });
    expect(result.body.data.purchaseVersion).toBe(purchaseAnalysisVersion(ctx.purchase));
    expect(result.headers['cache-control']).toContain('no-store');
    expect(ctx.analyzer.analyze).toHaveBeenCalledExactlyOnceWith({ content, contentType, filename: 'Privado.pdf' });
    expect(ctx.prisma.purchase.update).not.toHaveBeenCalled();
    expect(ctx.storage.save).not.toHaveBeenCalled(); expect(ctx.storage.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.prisma.auditLog.create.mock.calls)).not.toContain('Mercadona');
    expect(JSON.stringify(result.body)).not.toContain('private purchase document');
  });
  it('authentication and CSRF precede provider, storage and mutation', async () => {
    const ctx = fixture();
    await request(ctx.app).post(`${path}/analyze`).send({ consent: true }).expect(401);
    await auth(request(ctx.app).post(`${path}/analyze`), userId).send({ consent: true }).expect(403);
    expect(ctx.storage.get).not.toHaveBeenCalled(); expect(ctx.analyzer.analyze).not.toHaveBeenCalled();
  });
  it.each(['visible', 'member', 'document'])('hides an inaccessible %s before reading private bytes', async (field) => {
    const ctx = fixture(); ctx.state[field] = false;
    await ctx.analyze().expect(404);
    await auth(request(ctx.app).get(`${path}/analyses`), userId).expect(404);
    expect(ctx.storage.get).not.toHaveBeenCalled(); expect(ctx.analyzer.analyze).not.toHaveBeenCalled();
  });
  it('rejects unsupported MIME before storage and signature corruption before provider', async () => {
    const ctx = fixture(); ctx.document.contentType = 'text/html';
    await ctx.analyze().expect(415); expect(ctx.storage.get).not.toHaveBeenCalled();
    ctx.document.contentType = 'application/pdf'; ctx.storage.get.mockResolvedValue(Buffer.alloc(ctx.document.sizeBytes));
    await ctx.analyze().expect(415); expect(ctx.analyzer.analyze).not.toHaveBeenCalled();
  });
  it('requires explicit consent and rejects extra fields', async () => {
    const ctx = fixture();
    for (const body of [{}, { consent: false }, { consent: true, apiKey: 'sensitive-key' }]) {
      await write(request(ctx.app).post(`${path}/analyze`), userId).send(body).expect(400);
    }
    expect(ctx.analyzer.analyze).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain('sensitive-key');
  });
  it.each(['visible', 'member', 'document'])('rechecks %s after provider and does not return extracted data if revoked', async (field) => {
    const ctx = fixture(); ctx.analyzer.analyze.mockImplementation(async () => { ctx.state[field] = false; return receiptResult; });
    const result = await ctx.analyze().expect(404);
    expect(result.text).not.toContain('Mercadona'); expect(ctx.records).toHaveLength(0);
  });
  it('keeps previous analyses and returns latest first without altering purchase or document', async () => {
    const ctx = fixture();
    const first = (await ctx.analyze().expect(201)).body.data;
    const second = (await ctx.analyze().expect(201)).body.data;
    const list = (await auth(request(ctx.app).get(`${path}/analyses`), userId).expect(200)).body.data;
    expect(list.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(ctx.records).toHaveLength(2); expect(ctx.prisma.purchase.update).not.toHaveBeenCalled();
  });
  it.each([['AI_NOT_CONFIGURED', 503], ['AI_TIMEOUT', 504], ['AI_QUOTA_EXCEEDED', 503], ['AI_PROVIDER_RATE_LIMITED', 429], ['AI_SCHEMA_INVALID', 502]])('persists sanitized %s failure and usage without extraction', async (code, status) => {
    const ctx = fixture(); ctx.analyzer.analyze.mockRejectedValue(new ReceiptAnalysisError(code, { inputTokens: 7, outputTokens: 2, totalTokens: 9 }));
    const response = await ctx.analyze().expect(status);
    expect(response.body.code).toBe(code);
    expect(ctx.records[0]).toMatchObject({ status: 'FAILED', failureCode: code, extractedData: null, inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  });
  it('treats invalid mocked output as a failed analysis rather than trusting the adapter', async () => {
    const ctx = fixture(); ctx.analyzer.analyze.mockResolvedValue({ ...receiptResult, extractedData: { ...receiptData, totalCents: -1 } });
    await ctx.analyze().expect(502);
    expect(ctx.records[0]).toMatchObject({ failureCode: 'AI_SCHEMA_INVALID', inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });
  it('records the actual returned model while safely falling back to configured metadata', async () => {
    const ctx = fixture();
    ctx.analyzer.analyze.mockResolvedValueOnce({ ...receiptResult, model: 'receipt-model-2026-09-17' });
    expect((await ctx.analyze().expect(201)).body.data.model).toBe('receipt-model-2026-09-17');
    ctx.analyzer.analyze.mockResolvedValueOnce({ ...receiptResult, model: null });
    expect((await ctx.analyze().expect(201)).body.data.model).toBe(ctx.analyzer.model);
  });
  it.each(['storage', 'provider', 'database'])('never leaks raw %s errors to HTTP or development logs', async (failureType) => {
    const ctx = fixture(); const sensitive = 'sk-secret-base64-serial-IMEI-private';
    if (failureType === 'storage') ctx.storage.get.mockRejectedValue(new Error(sensitive));
    if (failureType === 'provider') ctx.analyzer.analyze.mockRejectedValue(new Error(sensitive));
    if (failureType === 'database') ctx.prisma.purchaseDocumentAnalysis.create.mockRejectedValue(new Error(sensitive));
    const response = await ctx.analyze();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.text).not.toContain(sensitive);
    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain(sensitive);
  });
  it('limits cost per authenticated user even without the application general limiter', async () => {
    const ctx = fixture({ aiConfig: { analysisLimitPerHour: 2 } });
    await ctx.analyze().expect(201); await ctx.analyze().expect(201);
    const limited = await ctx.analyze().expect(429);
    expect(limited.body.code).toBe('AI_ANALYSIS_RATE_LIMIT'); expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(2);
    await write(request(ctx.app).post(`${path}/analyze`), '81000000-0000-4000-8000-000000000006').send({ consent: true }).expect(201);
  });
  it('blocks duplicate concurrent calls and releases the lock after completion', async () => {
    const ctx = fixture(); let release;
    ctx.analyzer.analyze.mockReturnValueOnce(new Promise((done) => { release = done; }));
    const first = ctx.analyze().then((result) => result);
    await vi.waitFor(() => expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1));
    const duplicate = await ctx.analyze().expect(409);
    expect(duplicate.body.code).toBe('AI_ANALYSIS_IN_PROGRESS');
    release(receiptResult); expect((await first).status).toBe(201);
    await ctx.analyze().expect(201); expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(2);
  });
  it('serializable write retry never retries the paid provider call', async () => {
    const ctx = fixture(); let transactionNumber = 0;
    ctx.prisma.$transaction.mockImplementation(async (callback) => {
      transactionNumber += 1;
      if (transactionNumber === 2) throw Object.assign(new Error('Retry'), { code: 'P2034' });
      return callback(ctx.prisma);
    });
    await ctx.analyze().expect(201); expect(transactionNumber).toBe(3); expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1);
  });
});

describe('reviewed analysis schema', () => {
  const input = reviewedBody({ purchaseVersion: 'a'.repeat(64) });
  it('accepts edited fields and explicit apply choices', () => expect(confirmPurchaseAnalysisSchema.parse(input)).toEqual(input));
  it.each(['ownershipType', 'paymentMethod', 'paymentDate', 'financing', 'warrantyDurationMonths'])('rejects forbidden domain decision %s', (field) => {
    expect(() => confirmPurchaseAnalysisSchema.parse({ ...input, [field]: 'not allowed' })).toThrow();
  });
  it.each([{ totalCents: -1 }, { totalCents: 1.5 }, { purchaseDate: '2026-02-30' }, { totalCents: 2_147_483_648 }, { currency: 'ZZZ' }])('rejects invalid reviewed fields %j', (values) => {
    expect(() => confirmPurchaseAnalysisSchema.parse({ ...input, reviewedData: { ...input.reviewedData, ...values } })).toThrow();
  });
  it('does not invent missing item name/quantity, allowing null only when not applied', () => {
    const missing = { ...input, reviewedData: { ...input.reviewedData, items: [{ ...input.reviewedData.items[0], name: null, quantity: null }] } };
    expect(() => confirmPurchaseAnalysisSchema.parse(missing)).toThrow();
    expect(confirmPurchaseAnalysisSchema.parse({ ...missing, apply: { ...input.apply, items: 'NONE' } }).reviewedData.items[0].quantity).toBeNull();
  });
  it('checks any complete-line sum difference without overflow or inference', () => {
    expect(reviewedPurchaseTotalMismatch(input.reviewedData)).toBe(false);
    expect(reviewedPurchaseTotalMismatch({ ...input.reviewedData, totalCents: 901 })).toBe(true);
    expect(reviewedPurchaseTotalMismatch({ ...input.reviewedData, items: [{ totalPriceCents: null }] })).toBe(false);
    expect(reviewedPurchaseTotalMismatch({ totalCents: 0, items: Array.from({ length: 50 }, () => ({ totalPriceCents: 2_147_483_647 })) })).toBe(true);
  });
  it('requires an actual explicit selection, not confirm=true', () => {
    expect(() => analyzePurchaseDocumentSchema.parse({ confirm: true })).toThrow();
    expect(() => confirmPurchaseAnalysisSchema.parse({ confirm: true })).toThrow();
    expect(() => confirmPurchaseAnalysisSchema.parse({ ...input, apply: { merchant: false, purchaseDate: false, total: false, items: 'NONE' } })).toThrow();
  });
  it('canonicalizes relation ordering without ignoring changed values or versions', () => {
    const version = purchaseAnalysisVersion({ updatedAt: new Date('2026-09-17T10:00:00Z'), items: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }] });
    expect(purchaseAnalysisVersion({ items: [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }], updatedAt: new Date('2026-09-17T10:00:00Z') })).toBe(version);
    expect(purchaseAnalysisVersion({ items: [{ name: 'Changed', id: 'a' }, { name: 'B', id: 'b' }], updatedAt: new Date('2026-09-17T10:00:00Z') })).not.toBe(version);
    expect(purchaseAnalysisVersion({ items: [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }], updatedAt: new Date('2026-09-17T10:00:01Z') })).not.toBe(version);
  });
});
