import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createFinanceRouter } from '../src/modules/finance/index.js';
import { postgresPurchaseDocumentStorage } from '../src/modules/purchases/documentStorage.js';
import { authenticated, collectBinary, documentBodies, documentsTestApp, mutable, supportedDocuments, upload } from './helpers/purchaseDocumentsFixtures.js';

const enabled = process.env.PURCHASE_DOCUMENTS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_PURCHASE_DOCUMENTS_TEST');

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Purchase document integration tests only allow local PostgreSQL.');
  const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Document test', email: `${id}@purchase-documents.invalid` })) });
      const household = await tx.household.create({ data: { name: 'Documents test', ownerUserId: userIds[0], safetyMarginBps: 0, currentBalanceCents: 100_000 } });
      const otherHousehold = await tx.household.create({ data: { name: 'Other documents test', ownerUserId: userIds[0] } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: ['Pablo', 'Natalia', 'Otro'][index], contributionBps: index === 0 ? 6000 : index === 1 ? 4000 : 0 } }));
      }
      await tx.householdUserAccess.create({ data: { householdId: otherHousehold.id, userId: userIds[0], role: 'OWNER' } });
      const createPurchase = (data = {}) => tx.purchase.create({ data: {
        householdId: household.id, merchant: 'Apple Store', purchaseDate: new Date('2026-09-17T00:00:00Z'), totalCents: 99_900,
        ownershipType: 'HOUSEHOLD', items: { create: [{ name: 'iPhone 17' }, { name: 'Cable' }] }, ...data,
      }, include: { items: true } });
      const common = await createPurchase();
      const personal = await createPurchase({ ownershipType: 'PERSONAL', personalPersonId: people[1].id });
      const split = await createPurchase({ ownershipType: 'SPLIT', shares: { create: [
        { householdPersonId: people[1].id, shareBps: 6000 }, { householdPersonId: people[2].id, shareBps: 4000 },
      ] } });
      const foreign = await createPurchase({ householdId: otherHousehold.id });
      let sequence = 0;
      const adapter = new Proxy(tx, { get: (target, key) => key === '$transaction'
        ? async (callback) => {
          const savepoint = `purchase_document_operation_${sequence++}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            const result = await callback(adapter);
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            throw error;
          }
        } : Reflect.get(target, key) });
      const app = documentsTestApp(adapter, { financeRouter: createFinanceRouter });
      const purchasePath = (purchase = common, householdId = household.id) => `/api/households/${householdId}/purchases/${purchase.id}`;
      const path = (purchase = common, householdId = household.id) => `${purchasePath(purchase, householdId)}/documents`;
      const add = async (purchase = common, userId = userIds[0], options = {}, targetApp = app) => (await upload(targetApp, path(purchase), userId, options).expect(201)).body.data;
      await operation(tx, { adapter, app, userIds, people, household, otherHousehold, common, personal, split, foreign, createPurchase, path, purchasePath, add });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 40_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchase documents HTTP with rollback-isolated PostgreSQL', () => {
  it.each(supportedDocuments)('stores %s privately and downloads exact original bytes', async (contentType, content, extension) => fixture(async (tx, { add, common, path, app, userIds }) => {
    const document = await add(common, userIds[0], { contentType, content, filename: `Documento${extension}` });
    expect(document).toMatchObject({ purchaseId: common.id, purchaseItemId: null, uploadedByUserId: userIds[0], contentType, sizeBytes: content.length, type: 'RECEIPT' });
    expect(document).not.toHaveProperty('content');
    const stored = await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } });
    expect(Buffer.from(stored.content)).toEqual(content);
    const download = await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[1]).buffer(true).parse(collectBinary).expect(200);
    expect(download.body).toEqual(content);
    expect(download.headers['content-type']).toBe(contentType);
    expect(download.headers['content-length']).toBe(String(content.length));
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(download.headers['cache-control']).toContain('no-store');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  }));

  it('associates with its own product, edits type/association, lists metadata only and audits without bytes', async () => fixture(async (tx, { add, app, userIds, common, path, purchasePath }) => {
    const itemId = common.items[0].id;
    const document = await add(common, userIds[0], { filename: 'Garantía sensible.pdf', query: { type: 'WARRANTY', purchaseItemId: itemId } });
    expect(document.purchaseItemId).toBe(itemId);
    const changed = (await mutable(request(app).patch(`${path()}/${document.id}`), userIds[0]).send({ type: 'INVOICE', purchaseItemId: null }).expect(200)).body.data;
    expect(changed).toMatchObject({ id: document.id, type: 'INVOICE', purchaseItemId: null });
    const list = (await authenticated(request(app).get(path()), userIds[1]).expect(200)).body.data;
    expect(list).toHaveLength(1);
    for (const forbidden of ['content', 'bytes', 'storageKey', 'url', 'publicUrl']) expect(list[0]).not.toHaveProperty(forbidden);
    expect(JSON.stringify(list)).not.toContain('private purchase document');
    const detail = (await authenticated(request(app).get(purchasePath()), userIds[0]).expect(200)).body.data;
    expect(JSON.stringify(detail)).not.toContain('private purchase document');
    const logs = await tx.auditLog.findMany({ where: { resourceType: 'PurchaseDocument', resourceId: document.id }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('Garantía sensible.pdf');
    expect(JSON.stringify(logs)).not.toContain('private purchase document');
    expect(logs.map((log) => log.action)).toEqual(expect.arrayContaining(['PURCHASE_DOCUMENT_ADDED', 'PURCHASE_DOCUMENT_CHANGED']));
  }));

  it('rejects product references across purchases or households on upload and PATCH', async () => fixture(async (tx, { app, userIds, personal, foreign, path, add, common }) => {
    const document = await add();
    for (const itemId of [personal.items[0].id, foreign.items[0].id, crypto.randomUUID()]) {
      const post = await upload(app, path(), userIds[0], { query: { type: 'WARRANTY', purchaseItemId: itemId } });
      expect([400, 404]).toContain(post.status);
      const patch = await mutable(request(app).patch(`${path()}/${document.id}`), userIds[0]).send({ purchaseItemId: itemId });
      expect([400, 404]).toContain(patch.status);
    }
    expect(await tx.purchaseDocument.count({ where: { purchaseId: common.id } })).toBe(1);
    expect((await tx.purchaseDocument.findUnique({ where: { id: document.id } })).purchaseItemId).toBeNull();
  }));

  it.each(['PERSONAL', 'SPLIT'])('inherits strict %s privacy for every operation, including unrelated OWNER', async (ownershipType) => fixture(async (_tx, { app, userIds, personal, split, path, add }) => {
    const purchase = ownershipType === 'PERSONAL' ? personal : split;
    const document = await add(purchase, userIds[1]);
    const endpoint = path(purchase);
    const permitted = ownershipType === 'PERSONAL' ? [userIds[1]] : [userIds[1], userIds[2]];
    for (const userId of permitted) {
      await authenticated(request(app).get(endpoint), userId).expect(200);
      await authenticated(request(app).get(`${endpoint}/${document.id}/content?disposition=inline`), userId).expect(200);
    }
    const forbidden = ownershipType === 'PERSONAL' ? [userIds[0], userIds[2]] : [userIds[0]];
    for (const userId of forbidden) {
      await authenticated(request(app).get(endpoint), userId).expect(404);
      await upload(app, endpoint, userId).expect(404);
      await authenticated(request(app).get(`${endpoint}/${document.id}/content`), userId).expect(404);
      await mutable(request(app).patch(`${endpoint}/${document.id}`), userId).send({ type: 'OTHER' }).expect(404);
      await mutable(request(app).delete(`${endpoint}/${document.id}`), userId).expect(404);
    }
  }));

  it('does not allow resource ID mixing, missing purchases or access from another household', async () => fixture(async (_tx, { app, userIds, foreign, personal, path, add, otherHousehold, household }) => {
    const document = await add();
    const impossible = path({ id: crypto.randomUUID() });
    await authenticated(request(app).get(impossible), userIds[0]).expect(404);
    await upload(app, impossible, userIds[0]).expect(404);
    await authenticated(request(app).get(path(foreign, household.id)), userIds[0]).expect(404);
    await authenticated(request(app).get(path(foreign, otherHousehold.id)), userIds[1]).expect(404);
    const ownOtherPurchase = path(foreign, otherHousehold.id);
    await authenticated(request(app).get(`${ownOtherPurchase}/${document.id}/content`), userIds[0]).expect(404);
    await mutable(request(app).patch(`${ownOtherPurchase}/${document.id}`), userIds[0]).send({ type: 'OTHER' }).expect(404);
    await mutable(request(app).delete(`${ownOtherPurchase}/${document.id}`), userIds[0]).expect(404);
    await authenticated(request(app).get(`${path(personal)}/${document.id}/content`), userIds[1]).expect(404);
  }));

  it('ownership reassignment revokes document access immediately without leaking cached parent visibility', async () => fixture(async (_tx, { app, userIds, people, path, purchasePath, add }) => {
    const document = await add();
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[0]).expect(200);
    await mutable(request(app).patch(purchasePath()), userIds[0]).send({ ownershipType: 'PERSONAL', personalPersonId: people[1].id }).expect(200);
    await authenticated(request(app).get(path()), userIds[0]).expect(404);
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[0]).expect(404);
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(404);
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[1]).expect(200);
  }));

  it('archived purchases hide all document operations and preserve stored data; revoked membership is denied', async () => fixture(async (tx, { app, userIds, common, household, path, purchasePath, add }) => {
    const document = await add();
    await tx.householdUserAccess.update({ where: { householdId_userId: { householdId: household.id, userId: userIds[1] } }, data: { isActive: false, revokedAt: new Date() } });
    await authenticated(request(app).get(path()), userIds[1]).expect(404);
    await upload(app, path(), userIds[1]).expect(404);
    await mutable(request(app).delete(purchasePath()), userIds[0]).expect(200);
    await authenticated(request(app).get(path()), userIds[0]).expect(404);
    await upload(app, path(), userIds[0]).expect(404);
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[0]).expect(404);
    await mutable(request(app).patch(`${path()}/${document.id}`), userIds[0]).send({ type: 'OTHER' }).expect(404);
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(404);
    expect(await tx.purchaseDocument.count({ where: { purchaseId: common.id } })).toBe(1);
    expect(await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } })).not.toBeNull();
  }));

  it('deleting a product keeps its document attached to the whole purchase, never an orphaned binary', async () => fixture(async (tx, { app, userIds, common, path, purchasePath, add }) => {
    const product = common.items[0];
    const document = await add(common, userIds[0], { query: { type: 'WARRANTY', purchaseItemId: product.id } });
    await mutable(request(app).delete(`${purchasePath()}/items/${product.id}`), userIds[0]).expect(200);
    const list = (await authenticated(request(app).get(path()), userIds[0]).expect(200)).body.data;
    expect(list[0]).toMatchObject({ id: document.id, purchaseId: common.id, purchaseItemId: null });
    expect(await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } })).not.toBeNull();
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[0]).expect(200);
  }));

  it('deletes metadata and stored binary atomically, audits removal and returns 404 thereafter', async () => fixture(async (tx, { app, userIds, path, add }) => {
    const document = await add();
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(200);
    expect(await tx.purchaseDocument.findUnique({ where: { id: document.id } })).toBeNull();
    expect(await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } })).toBeNull();
    await authenticated(request(app).get(`${path()}/${document.id}/content`), userIds[0]).expect(404);
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(404);
    const log = await tx.auditLog.findFirst({ where: { resourceId: document.id, action: 'PURCHASE_DOCUMENT_DELETED' } });
    expect(log).not.toBeNull();
    expect(JSON.stringify(log)).not.toContain('private purchase document');
  }));

  it('storage save failures roll back both bytes and metadata', async () => fixture(async (tx, { adapter, userIds, common, path }) => {
    const documentStorage = { ...postgresPurchaseDocumentStorage, save: async (database_, args) => {
      await postgresPurchaseDocumentStorage.save(database_, args);
      throw new Error('Synthetic storage write failure');
    } };
    const app = documentsTestApp(adapter, { documentStorage });
    await upload(app, path(), userIds[0]).expect(503);
    expect(await tx.purchaseDocument.count({ where: { purchaseId: common.id } })).toBe(0);
    expect(await tx.purchaseDocumentContent.count({ where: { document: { purchaseId: common.id } } })).toBe(0);
    expect(await tx.auditLog.count({ where: { resourceType: 'PurchaseDocument' } })).toBe(0);
  }));

  it('storage delete failures return error and roll back both stored content and metadata', async () => fixture(async (tx, { adapter, userIds, path, add }) => {
    const document = await add();
    const documentStorage = { ...postgresPurchaseDocumentStorage, delete: async (database_, args) => {
      await postgresPurchaseDocumentStorage.delete(database_, args);
      throw new Error('Synthetic storage deletion failure');
    } };
    const app = documentsTestApp(adapter, { documentStorage });
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(503);
    expect(await tx.purchaseDocument.findUnique({ where: { id: document.id } })).not.toBeNull();
    expect(Buffer.from((await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } })).content)).toEqual(documentBodies.pdf);
    expect(await tx.auditLog.count({ where: { resourceId: document.id, action: 'PURCHASE_DOCUMENT_DELETED' } })).toBe(0);
  }));

  it('audit failure after storage mutation also rolls back upload and deletion', async () => fixture(async (tx, { adapter, userIds, common, path, add }) => {
    const document = await add();
    const failing = new Proxy(adapter, { get: (target, key) => key === '$transaction'
      ? (callback) => adapter.$transaction((inner) => callback(new Proxy(inner, { get: (modelTarget, model) => model === 'auditLog' ? { create: () => { throw new Error('Synthetic audit failure'); } } : Reflect.get(modelTarget, model) })))
      : Reflect.get(target, key) });
    const app = documentsTestApp(failing);
    await upload(app, path(), userIds[0]).expect(500);
    expect(await tx.purchaseDocument.count({ where: { purchaseId: common.id } })).toBe(1);
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(500);
    expect(await tx.purchaseDocument.findUnique({ where: { id: document.id } })).not.toBeNull();
    expect(await tx.purchaseDocumentContent.findUnique({ where: { documentId: document.id } })).not.toBeNull();
  }));

  it('upload/edit/delete leave financial calculations and every expense source unchanged', async () => fixture(async (tx, { app, userIds, household, path, add }) => {
    const endpoint = `/api/households/${household.id}/dashboard?date=2026-09-17`;
    const before = (await authenticated(request(app).get(endpoint), userIds[0]).expect(200)).body.data;
    const document = await add();
    await mutable(request(app).patch(`${path()}/${document.id}`), userIds[0]).send({ type: 'OTHER' }).expect(200);
    await mutable(request(app).delete(`${path()}/${document.id}`), userIds[0]).expect(200);
    const after = (await authenticated(request(app).get(endpoint), userIds[0]).expect(200)).body.data;
    expect(after.budget).toEqual(before.budget);
    expect(after.monthlyProgress).toEqual(before.monthlyProgress);
    expect(after.cashCoverage).toEqual(before.cashCoverage);
    for (const model of ['oneTimeExpense', 'recurringExpense', 'utilityInvoice', 'householdAccount']) expect(await tx[model].count({ where: { householdId: household.id } })).toBe(0);
  }));

  it('database constraints reject cross-purchase items, missing content and mismatched binary sizes at commit', async () => fixture(async (tx, { add, common, foreign, userIds }) => {
    const document = await add();
    const reject = async (operation) => {
      await tx.$executeRawUnsafe('SAVEPOINT invalid_purchase_document');
      let rejected = false;
      try { await operation(); await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); } catch { rejected = true; }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_purchase_document');
      expect(rejected).toBe(true);
    };
    await reject(() => tx.purchaseDocument.update({ where: { id: document.id }, data: { purchaseItemId: foreign.items[0].id } }));
    await reject(() => tx.purchaseDocumentContent.delete({ where: { documentId: document.id } }));
    await reject(() => tx.purchaseDocumentContent.update({ where: { documentId: document.id }, data: { content: Buffer.from('mismatch') } }));
    await reject(() => tx.purchaseDocument.update({ where: { id: document.id }, data: { sizeBytes: 0 } }));
    await reject(() => tx.purchaseDocument.update({ where: { id: document.id }, data: { contentType: 'image/svg+xml' } }));
    await reject(() => tx.purchaseDocument.create({ data: { purchaseId: common.id, uploadedByUserId: userIds[0], filename: 'missing.pdf', contentType: 'application/pdf', sizeBytes: 1 } }));
  }));
});
