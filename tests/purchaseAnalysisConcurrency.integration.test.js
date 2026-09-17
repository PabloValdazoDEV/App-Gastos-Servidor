import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { analysisTestApp, makeReceiptAnalyzer, reviewedBody } from './helpers/purchaseAnalysisFixtures.js';
import { mutable as write, upload } from './helpers/purchaseDocumentsFixtures.js';
import { financingInput } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_ANALYSIS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBarrier(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The concurrent test did not reach its barrier.')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

// No outer transaction or mocked serialization error: every HTTP request opens
// a separate real Serializable transaction. The hook only controls interleaving
// after PostgreSQL has returned the analysis row to that transaction.
function withAnalysisReadHook(prisma, onRead) {
  return new Proxy(prisma, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (operation, options) => target.$transaction((tx) => operation(new Proxy(tx, {
      get(transaction, key) {
        if (key !== 'purchaseDocumentAnalysis') return Reflect.get(transaction, key);
        return new Proxy(transaction.purchaseDocumentAnalysis, { get(model, method) {
          if (method !== 'findFirst') return Reflect.get(model, method);
          return async (...args) => {
            const analysis = await model.findFirst(...args);
            await onRead(tx, analysis);
            return analysis;
          };
        } });
      },
    })), { ...options, maxWait: 10000, timeout: 15000 });
  } });
}

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) {
    throw new Error('Analysis concurrency tests require local PostgreSQL.');
  }
  const userId = crypto.randomUUID();
  const householdId = crypto.randomUUID();
  const personId = crypto.randomUUID();
  try {
    await database.$transaction(async (tx) => {
      await tx.user.create({ data: { id: userId, name: 'Isolated concurrency test', email: `${userId}@analysis-concurrency.invalid` } });
      await tx.household.create({ data: { id: householdId, name: 'Isolated analysis concurrency', ownerUserId: userId, currentBalanceCents: 50000, safetyMarginBps: 0 } });
      await tx.householdUserAccess.create({ data: { householdId, userId, role: 'OWNER' } });
      await tx.householdPerson.create({ data: { id: personId, householdId, linkedUserId: userId, name: 'Test person', contributionBps: 10000 } });
    });
    const analyzer = makeReceiptAnalyzer();
    const app = analysisTestApp(database, { receiptAnalyzer: analyzer });
    const base = `/api/households/${householdId}/purchases`;
    const purchase = (await write(request(app).post(base), userId).send({
      merchant: 'Original', purchaseDate: '2026-09-17', totalCents: 120000,
      paymentMethod: 'FINANCED', financing: { ...financingInput, downPaymentPaidAt: '2026-09-17' },
      items: [{ name: 'Existing product', quantity: 1, serialNumber: 'CONCURRENCY-PRIVATE', warrantyDurationMonths: 24 }],
    }).expect(201)).body.data;
    await write(request(app).post(`${base}/${purchase.id}/installments/${purchase.financing.installments[0].id}/pay`), userId)
      .send({ actualAmountCents: 5400, paidAt: '2026-09-17', notes: 'Existing real payment' }).expect(200);
    const document = (await upload(app, `${base}/${purchase.id}/documents`, userId).expect(201)).body.data;
    const documentPath = `${base}/${purchase.id}/documents/${document.id}`;
    const analysis = (await write(request(app).post(`${documentPath}/analyze`), userId)
      .send({ consent: true }).expect(201)).body.data;
    const purchaseBefore = await database.purchase.findUnique({ where: { id: purchase.id }, include: { items: true } });
    const financingBefore = await database.purchaseFinancing.findUnique({
      where: { id: purchase.financing.id }, include: { installments: { orderBy: { sequence: 'asc' } } },
    });
    const confirmationBody = reviewedBody(analysis, {
      apply: { merchant: true, purchaseDate: false, total: false, items: 'ADD' },
    });
    const confirm = (targetApp) => write(request(targetApp).post(`${documentPath}/analyses/${analysis.id}/confirm`), userId).send(confirmationBody);
    await operation({ app, analyzer, base, userId, householdId, purchase, analysis, purchaseBefore, financingBefore, confirm });
  } finally {
    // Only this test's randomly generated household/user IDs are targeted.
    // Purchase-owned rows cascade; audit/access/person rows are removed exactly.
    await database.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { householdId } });
      await tx.purchase.deleteMany({ where: { householdId } });
      await tx.householdUserAccess.deleteMany({ where: { householdId, userId } });
      await tx.householdPerson.deleteMany({ where: { id: personId, householdId } });
      await tx.household.deleteMany({ where: { id: householdId, ownerUserId: userId } });
      await tx.user.deleteMany({ where: { id: userId, email: `${userId}@analysis-concurrency.invalid` } });
    });
    expect(await database.user.count({ where: { id: userId } })).toBe(0);
    expect(await database.household.count({ where: { id: householdId } })).toBe(0);
  }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchase analysis real PostgreSQL concurrency', () => {
  it('commits one simultaneous confirmation, rejects the other and preserves payment history', async () => fixture(async (ctx) => {
    const barrier = deferred();
    const initialReads = [];
    const transactions = [];
    let reads = 0;
    const concurrentDatabase = withAnalysisReadHook(database, async (tx, analysis) => {
      reads += 1;
      if (reads > 2) return;
      initialReads.push(analysis.status);
      const [{ id }] = await tx.$queryRaw`SELECT txid_current()::text AS id`;
      transactions.push(id);
      if (initialReads.length === 2 && transactions.length === 2) barrier.resolve();
      await waitForBarrier(barrier.promise);
    });
    const concurrentApp = analysisTestApp(concurrentDatabase, { receiptAnalyzer: ctx.analyzer });
    let responses;
    try {
      const outcomes = await Promise.allSettled([ctx.confirm(concurrentApp), ctx.confirm(concurrentApp)]);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      responses = outcomes.map((outcome) => outcome.value);
    } finally { barrier.resolve(); }
    expect(initialReads).toEqual(['COMPLETED', 'COMPLETED']);
    expect(new Set(transactions).size).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409).body.code).toBe('AI_ANALYSIS_NOT_CONFIRMABLE');
    expect(reads).toBeGreaterThanOrEqual(3); // Actual P2034 triggered the normal retry/read.
    const purchase = await database.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } });
    expect(purchase.items).toHaveLength(2);
    expect(purchase.items.filter((item) => item.name === 'Producto corregido')).toHaveLength(1);
    expect(purchase.items.find((item) => item.id === ctx.purchase.items[0].id)).toEqual(ctx.purchaseBefore.items[0]);
    expect(purchase).toMatchObject({ totalCents: ctx.purchaseBefore.totalCents, paymentMethod: 'FINANCED', paymentAllocationSnapshot: ctx.purchaseBefore.paymentAllocationSnapshot });
    expect(await database.purchaseFinancing.findUnique({
      where: { id: ctx.purchase.financing.id }, include: { installments: { orderBy: { sequence: 'asc' } } },
    })).toEqual(ctx.financingBefore);
    expect(await database.purchaseDocumentAnalysis.findUnique({ where: { id: ctx.analysis.id } })).toMatchObject({ status: 'CONFIRMED', confirmedByUserId: ctx.userId });
    expect(await database.auditLog.count({ where: { householdId: ctx.householdId, resourceId: ctx.analysis.id, action: 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED' } })).toBe(1);
    expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1);
  }), 30000);

  it('rejects a confirmation whose snapshot becomes stale during a concurrent ordinary edit', async () => fixture(async (ctx) => {
    const read = deferred();
    const release = deferred();
    let reads = 0;
    const concurrentDatabase = withAnalysisReadHook(database, async () => {
      reads += 1;
      if (reads > 1) return;
      read.resolve();
      await waitForBarrier(release.promise);
    });
    const concurrentApp = analysisTestApp(concurrentDatabase, { receiptAnalyzer: ctx.analyzer });
    const confirmation = ctx.confirm(concurrentApp).then((response) => response);
    let response;
    try {
      await waitForBarrier(read.promise);
      await write(request(ctx.app).patch(`${ctx.base}/${ctx.purchase.id}`), ctx.userId)
        .send({ merchant: 'Committed concurrent edit' }).expect(200);
      release.resolve();
      response = await confirmation;
    } finally {
      release.resolve();
      await confirmation;
    }
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('AI_ANALYSIS_STALE');
    expect(reads).toBeGreaterThanOrEqual(2);
    const purchase = await database.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } });
    expect(purchase.merchant).toBe('Committed concurrent edit');
    expect(purchase.items).toEqual(ctx.purchaseBefore.items);
    expect(await database.purchaseFinancing.findUnique({
      where: { id: ctx.purchase.financing.id }, include: { installments: { orderBy: { sequence: 'asc' } } },
    })).toEqual(ctx.financingBefore);
    expect(await database.purchaseDocumentAnalysis.findUnique({ where: { id: ctx.analysis.id } })).toMatchObject({ status: 'COMPLETED' });
    expect(await database.auditLog.count({ where: { householdId: ctx.householdId, resourceId: ctx.analysis.id, action: 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED' } })).toBe(0);
  }), 30000);
});
