import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { analysisTestApp, makeReceiptAnalyzer, receiptData, receiptResult, reviewedBody } from './helpers/purchaseAnalysisFixtures.js';
import { authenticated as auth, mutable as write, documentBodies, upload } from './helpers/purchaseDocumentsFixtures.js';
import { financingInput } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_ANALYSIS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_PURCHASE_ANALYSIS_TEST');

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Analysis tests require local PostgreSQL.');
  const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Analysis test', email: `${id}@purchase-analysis.invalid` })) });
      const household = await tx.household.create({ data: { name: 'Analysis isolated test', ownerUserId: userIds[0], currentBalanceCents: 50000, safetyMarginBps: 0 } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: `Persona ${index}`, contributionBps: index === 0 ? 10000 : 0 } }));
      }
      let sequence = 0;
      const adapter = new Proxy(tx, { get: (target, key) => key === '$transaction' ? async (callback) => {
        const savepoint = `purchase_analysis_operation_${sequence++}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(adapter);
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`); throw error; }
      } : Reflect.get(target, key) });
      const analyzer = makeReceiptAnalyzer();
      const app = analysisTestApp(adapter, { receiptAnalyzer: analyzer });
      const base = `/api/households/${household.id}/purchases`;
      const create = async (input = {}, actor = userIds[0]) => (await write(request(app).post(base), actor).send({
        merchant: 'Original', purchaseDate: '2026-09-17', totalCents: 120000,
        items: [{ name: 'Producto existente', quantity: 1, priceCents: 120000, serialNumber: 'SERIAL-PRIVATE', warrantyDurationMonths: 24 }], ...input,
      }).expect(201)).body.data;
      const purchase = await create();
      const add = async (target = purchase, actor = userIds[0]) => (await upload(app, `${base}/${target.id}/documents`, actor, {
        query: { type: 'RECEIPT', purchaseItemId: target.items[0].id },
      }).expect(201)).body.data;
      const document = await add();
      const path = (target = purchase, doc = document) => `${base}/${target.id}/documents/${doc.id}`;
      const analyze = async (target = purchase, doc = document, actor = userIds[0], targetApp = app) =>
        (await write(request(targetApp).post(`${path(target, doc)}/analyze`), actor).send({ consent: true }).expect(201)).body.data;
      const confirm = (analysis, body = reviewedBody(analysis), target = purchase, doc = document, actor = userIds[0], targetApp = app) =>
        write(request(targetApp).post(`${path(target, doc)}/analyses/${analysis.id}/confirm`), actor).send(body);
      await operation(tx, { adapter, analyzer, app, household, people, userIds, base, purchase, document, create, add, path, analyze, confirm });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 45000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally { expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0); }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchase analysis PostgreSQL atomic domain integration', () => {
  it('analyzes without automatically changing purchase, products, guarantees, bytes or balances', async () => fixture(async (tx, ctx) => {
    const before = await tx.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } });
    const analysis = await ctx.analyze();
    expect(analysis).toMatchObject({ status: 'COMPLETED', extractedData: receiptData, inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(await tx.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } })).toEqual(before);
    expect(Buffer.from((await tx.purchaseDocumentContent.findUnique({ where: { documentId: ctx.document.id } })).content)).toEqual(documentBodies.pdf);
    expect((await tx.household.findUnique({ where: { id: ctx.household.id } })).currentBalanceCents).toBe(50000);
    expect(await tx.recurringExpense.count({ where: { householdId: ctx.household.id } })).toBe(0);
    expect(await tx.oneTimeExpense.count({ where: { householdId: ctx.household.id } })).toBe(0);
  }));
  it('confirms reviewed values atomically, adds items and retains original extraction/document links', async () => fixture(async (tx, ctx) => {
    const analysis = await ctx.analyze();
    const result = (await ctx.confirm(analysis).expect(200)).body.data;
    expect(result.purchase).toMatchObject({ merchant: 'Comercio revisado', purchaseDate: '2026-09-16', totalCents: 900, paymentDate: null, paidAmountCents: null, ownershipType: 'HOUSEHOLD' });
    expect(result.purchase.items).toHaveLength(2);
    expect(result.purchase.items.find((item) => item.id === ctx.purchase.items[0].id)).toMatchObject({ name: 'Producto existente', serialNumber: 'SERIAL-PRIVATE', warrantyDurationMonths: 24, warrantyEndsAt: '2028-09-16' });
    expect(result.purchase.items.find((item) => item.id !== ctx.purchase.items[0].id)).toMatchObject({ name: 'Producto corregido', quantity: 2, priceCents: 900, brand: 'Marca revisada', warrantySource: null, serialNumber: null });
    expect(result.analysis).toMatchObject({ status: 'CONFIRMED', confirmedByUserId: ctx.userIds[0], extractedData: receiptData, reviewedData: { merchant: 'Comercio revisado', totalCents: 900, apply: { items: 'ADD' }, acknowledgeTotalMismatch: false } });
    expect((await tx.purchaseDocument.findUnique({ where: { id: ctx.document.id } })).purchaseItemId).toBe(ctx.purchase.items[0].id);
    expect(Buffer.from((await tx.purchaseDocumentContent.findUnique({ where: { documentId: ctx.document.id } })).content)).toEqual(documentBodies.pdf);
    const audits = await tx.auditLog.findMany({ where: { resourceId: analysis.id } });
    expect(audits.map((log) => log.action)).toEqual(expect.arrayContaining(['PURCHASE_DOCUMENT_ANALYZED', 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED']));
    expect(JSON.stringify(audits)).not.toContain('SERIAL-PRIVATE'); expect(JSON.stringify(audits)).not.toContain('Mercadona');
    await ctx.confirm(analysis).expect(409);
    expect(await tx.purchaseItem.count({ where: { purchaseId: ctx.purchase.id } })).toBe(2);
  }));
  it('allows selecting only purchase metadata, preserving all products and real upfront payment/snapshot', async () => fixture(async (tx, ctx) => {
    const upfront = await ctx.create({ paymentMethod: 'UPFRONT', paymentDate: '2026-09-17', paidAmountCents: 119000 });
    const doc = await ctx.add(upfront); const analysis = await ctx.analyze(upfront, doc);
    const before = await tx.purchase.findUnique({ where: { id: upfront.id }, include: { items: true } });
    const body = reviewedBody(analysis, { apply: { merchant: true, purchaseDate: false, total: true, items: 'NONE' } });
    const result = (await ctx.confirm(analysis, body, upfront, doc).expect(200)).body.data.purchase;
    expect(result).toMatchObject({ totalCents: 900, paymentDate: '2026-09-17', paidAmountCents: 119000 });
    const after = await tx.purchase.findUnique({ where: { id: upfront.id }, include: { items: true } });
    expect(after.paymentAllocationSnapshot).toEqual(before.paymentAllocationSnapshot);
    expect(after.items).toEqual(before.items);
  }));
  it('permits reanalysis without overwriting history and confirms a selected prior draft only once', async () => fixture(async (tx, ctx) => {
    const first = await ctx.analyze(); const second = await ctx.analyze();
    const history = (await auth(request(ctx.app).get(`${ctx.path()}/analyses`), ctx.userIds[0]).expect(200)).body.data;
    expect(history.map((analysis) => analysis.id)).toEqual([second.id, first.id]);
    await ctx.confirm(first).expect(200);
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: second.id } })).status).toBe('COMPLETED');
  }));
  it('rejects a stale review then permits a fresh explicit review without another provider call', async () => fixture(async (tx, ctx) => {
    const analysis = await ctx.analyze();
    await write(request(ctx.app).patch(`${ctx.base}/${ctx.purchase.id}`), ctx.userIds[0]).send({ merchant: 'Editado externamente' }).expect(200);
    const stale = await ctx.confirm(analysis).expect(409);
    expect(stale.body.code).toBe('AI_ANALYSIS_STALE');
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: analysis.id } })).status).toBe('COMPLETED');
    const fresh = (await auth(request(ctx.app).get(`${ctx.path()}/analyses`), ctx.userIds[0]).expect(200)).body.data[0];
    expect(fresh.purchaseVersion).not.toBe(analysis.purchaseVersion);
    await ctx.confirm(fresh).expect(200); expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1);
  }));
  it('a serialization retry rechecks concurrent confirmation and never appends items twice', async () => fixture(async (tx, ctx) => {
    const analysis = await ctx.analyze(); let firstAttempt = true;
    const retryingAdapter = new Proxy(ctx.adapter, { get: (target, key) => key === '$transaction' ? async (callback, options) => {
      if (firstAttempt) {
        firstAttempt = false;
        await ctx.confirm(analysis).expect(200);
        throw Object.assign(new Error('Serialization conflict after concurrent confirmation'), { code: 'P2034' });
      }
      return target.$transaction(callback, options);
    } : Reflect.get(target, key) });
    const retryingApp = analysisTestApp(retryingAdapter, { receiptAnalyzer: ctx.analyzer });
    const result = await ctx.confirm(analysis, reviewedBody(analysis), ctx.purchase, ctx.document, ctx.userIds[0], retryingApp).expect(409);
    expect(result.body.code).toBe('AI_ANALYSIS_NOT_CONFIRMABLE');
    expect(await tx.purchaseItem.count({ where: { purchaseId: ctx.purchase.id } })).toBe(2);
    expect(await tx.auditLog.count({ where: { resourceId: analysis.id, action: 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED' } })).toBe(1);
    expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1);
  }));
  it('cannot bypass PAID financing guards and can apply merchant/products without changing protected total', async () => fixture(async (tx, ctx) => {
    const financed = await ctx.create({ paymentMethod: 'FINANCED', financing: financingInput });
    await write(request(ctx.app).post(`${ctx.base}/${financed.id}/installments/${financed.financing.installments[0].id}/pay`), ctx.userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(200);
    const doc = await ctx.add(financed); const analysis = await ctx.analyze(financed, doc);
    const paidBefore = await tx.purchaseInstallment.findMany({ where: { purchaseFinancingId: financed.financing.id }, orderBy: { sequence: 'asc' } });
    const blocked = reviewedBody(analysis); blocked.reviewedData.totalCents = 120100; blocked.acknowledgeTotalMismatch = true;
    await ctx.confirm(analysis, blocked, financed, doc).expect(409);
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: analysis.id } })).status).toBe('COMPLETED');
    const allowed = reviewedBody(analysis, { apply: { merchant: true, purchaseDate: false, total: false, items: 'ADD' } });
    const result = (await ctx.confirm(analysis, allowed, financed, doc).expect(200)).body.data;
    expect(result.purchase.totalCents).toBe(120000);
    expect(result.analysis.reviewedData.totalCents).toBe(900);
    expect(await tx.purchaseInstallment.findMany({ where: { purchaseFinancingId: financed.financing.id }, orderBy: { sequence: 'asc' } })).toEqual(paidBefore);
  }));
  it('reuses financing validation before PAID history too, without destroying the plan', async () => fixture(async (tx, ctx) => {
    const financed = await ctx.create({ paymentMethod: 'FINANCED', financing: financingInput });
    const doc = await ctx.add(financed); const analysis = await ctx.analyze(financed, doc);
    const before = await tx.purchaseFinancing.findUnique({ where: { id: financed.financing.id }, include: { installments: true } });
    await ctx.confirm(analysis, reviewedBody(analysis), financed, doc).expect(400);
    expect(await tx.purchaseFinancing.findUnique({ where: { id: financed.financing.id }, include: { installments: true } })).toEqual(before);
  }));
  it('requires conscious acknowledgement for any reviewed total mismatch', async () => fixture(async (_tx, ctx) => {
    const analysis = await ctx.analyze(); const body = reviewedBody(analysis); body.reviewedData.totalCents = 901;
    const rejected = await ctx.confirm(analysis, body).expect(400);
    expect(rejected.body.code).toBe('AI_TOTAL_MISMATCH_REQUIRES_CONFIRMATION');
    await ctx.confirm(analysis, { ...body, acknowledgeTotalMismatch: true }).expect(200);
  }));
  it('never converts unknown/foreign currency into household cents implicitly', async () => fixture(async (_tx, ctx) => {
    const analysis = await ctx.analyze();
    for (const currency of [null, 'USD']) {
      const body = reviewedBody(analysis); body.reviewedData.currency = currency;
      const rejected = await ctx.confirm(analysis, body).expect(400); expect(rejected.body.code).toBe('AI_CURRENCY_MISMATCH');
    }
    await ctx.confirm(analysis).expect(200);
  }));
  it('rolls back purchase, appended items and analysis state if final audit fails', async () => fixture(async (tx, ctx) => {
    const analysis = await ctx.analyze();
    const before = await tx.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } });
    const failedAdapter = new Proxy(ctx.adapter, { get: (target, key) => key === '$transaction' ? (callback) => target.$transaction((database) => callback(new Proxy(database, { get: (inner, property) => property === 'auditLog' ? {
      create: async (input) => {
        if (input.data.action === 'PURCHASE_DOCUMENT_ANALYSIS_CONFIRMED') throw new Error('sensitive audit failure');
        return inner.auditLog.create(input);
      },
    } : Reflect.get(inner, property) }))) : Reflect.get(target, key) });
    const failingApp = analysisTestApp(failedAdapter, { receiptAnalyzer: ctx.analyzer });
    const response = await ctx.confirm(analysis, reviewedBody(analysis), ctx.purchase, ctx.document, ctx.userIds[0], failingApp).expect(503);
    expect(response.text).not.toContain('sensitive audit failure');
    expect(await tx.purchase.findUnique({ where: { id: ctx.purchase.id }, include: { items: true } })).toEqual(before);
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: analysis.id } })).status).toBe('COMPLETED');
  }));
  it.each(['PERSONAL', 'SPLIT'])('preserves %s privacy from unrelated OWNER for analyze/history/confirm', async (ownershipType) => fixture(async (_tx, ctx) => {
    const privatePurchase = await ctx.create(ownershipType === 'PERSONAL'
      ? { ownershipType, personalPersonId: ctx.people[1].id }
      : { ownershipType, shares: [{ householdPersonId: ctx.people[1].id, shareBps: 6000 }, { householdPersonId: ctx.people[2].id, shareBps: 4000 }] }, ctx.userIds[1]);
    const doc = await ctx.add(privatePurchase, ctx.userIds[1]); const analysis = await ctx.analyze(privatePurchase, doc, ctx.userIds[1]);
    await write(request(ctx.app).post(`${ctx.path(privatePurchase, doc)}/analyze`), ctx.userIds[0]).send({ consent: true }).expect(404);
    await auth(request(ctx.app).get(`${ctx.path(privatePurchase, doc)}/analyses`), ctx.userIds[0]).expect(404);
    await ctx.confirm(analysis, reviewedBody(analysis), privatePurchase, doc, ctx.userIds[0]).expect(404);
    expect(ctx.analyzer.analyze).toHaveBeenCalledTimes(1);
  }));
  it('rechecks ownership after remote processing and rejects confirmation after membership revocation', async () => fixture(async (tx, ctx) => {
    ctx.analyzer.analyze.mockImplementationOnce(async () => {
      await tx.purchase.update({ where: { id: ctx.purchase.id }, data: { ownershipType: 'PERSONAL', personalPersonId: ctx.people[1].id } });
      return receiptResult;
    });
    const rejected = await write(request(ctx.app).post(`${ctx.path()}/analyze`), ctx.userIds[0]).send({ consent: true }).expect(404);
    expect(rejected.text).not.toContain('Mercadona');
    expect(await tx.purchaseDocumentAnalysis.count({ where: { purchaseDocumentId: ctx.document.id } })).toBe(0);
    const analysis = await ctx.analyze(ctx.purchase, ctx.document, ctx.userIds[1]);
    await tx.householdUserAccess.update({ where: { householdId_userId: { householdId: ctx.household.id, userId: ctx.userIds[1] } }, data: { isActive: false, revokedAt: new Date() } });
    await ctx.confirm(analysis, reviewedBody(analysis), ctx.purchase, ctx.document, ctx.userIds[1]).expect(404);
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: analysis.id } })).status).toBe('COMPLETED');
  }));
  it('does not mix document or analysis IDs across purchases and hides archived analyses', async () => fixture(async (tx, ctx) => {
    const analysis = await ctx.analyze(); const other = await ctx.create(); const otherDocument = await ctx.add(other);
    await ctx.confirm(analysis, reviewedBody(analysis), other, otherDocument).expect(404);
    await auth(request(ctx.app).get(`${ctx.path(other, ctx.document)}/analyses`), ctx.userIds[0]).expect(404);
    await write(request(ctx.app).delete(`${ctx.base}/${ctx.purchase.id}`), ctx.userIds[0]).expect(200);
    await auth(request(ctx.app).get(`${ctx.path()}/analyses`), ctx.userIds[0]).expect(404);
    await ctx.confirm(analysis).expect(404);
    expect(await tx.purchaseDocumentAnalysis.count({ where: { purchaseDocumentId: ctx.document.id } })).toBe(1);
  }));
  it('enforces the existing fifty-product maximum without replacing old products', async () => fixture(async (tx, ctx) => {
    await tx.purchaseItem.createMany({ data: Array.from({ length: 49 }, (_unused, index) => ({ purchaseId: ctx.purchase.id, name: `Existente ${index}` })) });
    const analysis = await ctx.analyze();
    const response = await ctx.confirm(analysis).expect(400); expect(response.body.code).toBe('PURCHASE_ITEMS_LIMIT');
    expect(await tx.purchaseItem.count({ where: { purchaseId: ctx.purchase.id } })).toBe(50);
    expect((await tx.purchaseDocumentAnalysis.findUnique({ where: { id: analysis.id } })).status).toBe('COMPLETED');
  }));
});
