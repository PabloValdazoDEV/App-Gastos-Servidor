import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { authenticatedPayment as auth, createFinancedPurchase, financedPurchaseInput, financingInput, mutablePayment as write, paymentsTestApp, purchaseInput } from './helpers/purchasePaymentsFixtures.js';

const enabled = process.env.PURCHASE_PAYMENTS_DB_TEST === '1';
const database = enabled ? new PrismaClient() : null;
const rollback = new Error('ROLLBACK_PURCHASE_PAYMENTS_TEST');

async function fixture(operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Purchase payment integration tests only allow local PostgreSQL.');
  const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Payment test', email: `${id}@purchase-payments.invalid` })) });
      const household = await tx.household.create({ data: { name: 'Purchase payments test', ownerUserId: userIds[0], safetyMarginBps: 0, currentBalanceCents: 150_000 } });
      const otherHousehold = await tx.household.create({ data: { name: 'Other payments test', ownerUserId: userIds[0] } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: ['Pablo', 'Natalia', 'Otro'][index], contributionBps: index === 0 ? 6000 : index === 1 ? 4000 : 0 } }));
      }
      await tx.householdUserAccess.create({ data: { householdId: otherHousehold.id, userId: userIds[0], role: 'OWNER' } });
      let sequence = 0;
      const adapter = new Proxy(tx, { get: (target, key) => key === '$transaction'
        ? async (callback) => {
          const savepoint = `purchase_payment_operation_${sequence++}`;
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
      const app = paymentsTestApp(adapter);
      const base = `/api/households/${household.id}/purchases`;
      const create = (input = {}, userId = userIds[0]) => createFinancedPurchase(app, base, userId, input);
      const detail = async (purchaseId, userId = userIds[0]) => (await auth(request(app).get(`${base}/${purchaseId}`), userId).expect(200)).body.data;
      const pay = async (purchase, installment, input = {}, userId = userIds[0], targetApp = app) => (await write(request(targetApp).post(`${base}/${purchase.id}/installments/${installment.id}/pay`), userId)
        .send({ actualAmountCents: installment.expectedAmountCents, paidAt: '2026-09-17', ...input }).expect(200)).body.data;
      await operation(tx, { adapter, app, household, otherHousehold, people, userIds, base, create, detail, pay });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 45_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0);
  }
}

afterAll(async () => database?.$disconnect());

describe.skipIf(!enabled)('purchase payment HTTP model with rollback-isolated PostgreSQL', () => {
  it('registers an explicit UPFRONT payment without a fake one-installment financing', async () => fixture(async (tx, { app, base, userIds }) => {
    const { body } = await write(request(app).post(base), userIds[0]).send({ ...purchaseInput, paymentMethod: 'UPFRONT', paymentDate: '2026-09-16', paidAmountCents: 120_000 }).expect(201);
    expect(body.data).toMatchObject({ paymentMethod: 'UPFRONT', paymentDate: '2026-09-16', paidAmountCents: 120_000, financing: null });
    expect(await tx.purchaseFinancing.count({ where: { purchaseId: body.data.id } })).toBe(0);
    const result = (await write(request(app).patch(`${base}/${body.data.id}`), userIds[0]).send({ paymentDate: '2026-09-17', paidAmountCents: 119_900 }).expect(200)).body.data;
    expect(result).toMatchObject({ paymentDate: '2026-09-17', paidAmountCents: 119_900 });
  }));

  it('preserves legacy creation without inventing an upfront payment or paid deposit', async () => fixture(async (_tx, { app, base, userIds, create }) => {
    const legacy = (await write(request(app).post(base), userIds[0]).send(purchaseInput).expect(201)).body.data;
    expect(legacy).toMatchObject({ paymentDate: null, paidAmountCents: null, financing: null });
    const financed = await create();
    expect(financed.financing.downPaymentPaidAt).toBeNull();
    expect(financed.financing.installments.every((row) => row.status === 'PLANNED' && row.actualAmountCents === null && row.paidAt === null)).toBe(true);
    expect(financed.financing.progress).toMatchObject({ paidCents: 0, pendingCents: 130_000, paidInstallmentCount: 0, installmentCount: 20, downPaymentPendingCents: 20_000 });
  }));

  it('calculates principal, financing cost and exact 20 installments separately from the confirmed deposit', async () => fixture(async (tx, { create }) => {
    const purchase = await create({ financing: { ...financingInput, downPaymentPaidAt: '2026-09-17' } });
    expect(purchase).toMatchObject({ totalCents: 120_000, paymentMethod: 'FINANCED', paymentDate: null, paidAmountCents: null });
    expect(purchase.financing).toMatchObject({ downPaymentCents: 20_000, financedPrincipalCents: 100_000, financingTotalCents: 110_000, downPaymentPaidAt: '2026-09-17' });
    expect(purchase.financing.installments).toHaveLength(20);
    expect(purchase.financing.installments.map((row) => row.sequence)).toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));
    expect(purchase.financing.installments.reduce((sum, row) => sum + row.expectedAmountCents, 0)).toBe(110_000);
    expect(purchase.financing.progress).toMatchObject({ paidCents: 20_000, pendingCents: 110_000, paidInstallmentCount: 0, installmentCount: 20, costOfFinancingCents: 10_000, totalCostCents: 130_000, downPaymentPendingCents: 0 });
    expect(purchase.financing.progress.nextInstallment).toMatchObject({ sequence: 1, dueDate: '2026-10-15', expectedAmountCents: 5500 });
    expect(await tx.purchaseFinancing.count({ where: { purchaseId: purchase.id } })).toBe(1);
  }));

  it('anchors end-of-month installments and adjusts the last cent exactly', async () => fixture(async (_tx, { create }) => {
    const purchase = await create({ totalCents: 10_000, financing: { provider: null, downPaymentCents: 0, installmentCount: 3, installmentAmountCents: 3333, firstInstallmentDate: '2024-01-31', financingTotalCents: 10_000 } });
    expect(purchase.financing.installments.map((row) => [row.dueDate, row.expectedAmountCents])).toEqual([
      ['2024-01-31', 3333], ['2024-02-29', 3333], ['2024-03-31', 3334],
    ]);
  }));

  it('records an early real payment, corrects it without changing planned amounts, and reverses only with confirmation', async () => fixture(async (tx, { create, pay, app, base, userIds, detail }) => {
    const purchase = await create();
    const installment = purchase.financing.installments[0];
    const endpoint = `${base}/${purchase.id}/installments/${installment.id}`;
    const paid = await pay(purchase, installment, { actualAmountCents: 5400, notes: 'Pago anticipado' });
    expect(paid.financing.installments[0]).toMatchObject({ id: installment.id, status: 'PAID', paidAt: '2026-09-17', dueDate: '2026-10-15', expectedAmountCents: 5500, actualAmountCents: 5400, notes: 'Pago anticipado' });
    expect(paid.financing.progress).toMatchObject({ paidCents: 5400, pendingCents: 124_500, paidInstallmentCount: 1 });
    expect(paid.financing.progress.nextInstallment.sequence).toBe(2);
    await write(request(app).post(`${endpoint}/pay`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-16' }).expect(409);
    const corrected = (await write(request(app).patch(`${endpoint}/payment`), userIds[0]).send({ actualAmountCents: 5600, paidAt: '2026-09-16', notes: 'Importe corregido' }).expect(200)).body.data;
    expect(corrected.financing.installments[0]).toMatchObject({ expectedAmountCents: 5500, actualAmountCents: 5600, paidAt: '2026-09-16', notes: 'Importe corregido' });
    for (const body of [{}, { confirm: false }]) await write(request(app).delete(`${endpoint}/payment`), userIds[0]).send(body).expect(400);
    expect((await detail(purchase.id)).financing.installments[0].status).toBe('PAID');
    const reverted = (await write(request(app).delete(`${endpoint}/payment`), userIds[0]).send({ confirm: true }).expect(200)).body.data;
    expect(reverted.financing.installments[0]).toMatchObject({ status: 'PLANNED', actualAmountCents: null, paidAt: null });
    expect(reverted.financing.progress).toMatchObject({ paidCents: 0, pendingCents: 130_000, paidInstallmentCount: 0 });
    const audits = await tx.auditLog.findMany({ where: { resourceId: installment.id } });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits)).toContain('5400');
    expect(JSON.stringify(audits)).toContain('5600');
  }));

  it('blocks destructive structural/method edits with PAID history, even with reset confirmation; allows provider metadata', async () => fixture(async (_tx, { app, base, userIds, create, pay, detail }) => {
    const purchase = await create();
    await pay(purchase, purchase.financing.installments[0]);
    const path = `${base}/${purchase.id}`;
    for (const input of [
      { financing: { installmentCount: 21 } }, { financing: { firstInstallmentDate: '2026-11-15' } },
      { financing: { financingTotalCents: 111_000 } }, { financing: { installmentAmountCents: 5501 } },
      { totalCents: 121_000 }, { financing: { downPaymentCents: 21_000 } },
      { paymentMethod: 'UPFRONT', paymentDate: '2026-09-17', paidAmountCents: 120_000, confirmPaymentReset: true },
    ]) await write(request(app).patch(path), userIds[0]).send(input).expect(409);
    const before = await detail(purchase.id);
    const after = (await write(request(app).patch(path), userIds[0]).send({ financing: { provider: 'Nueva etiqueta' } }).expect(200)).body.data;
    expect(after.financing.provider).toBe('Nueva etiqueta');
    expect(after.financing.installments).toEqual(before.financing.installments);
    expect(after.financing.id).toBe(before.financing.id);
  }));

  it('regenerates only unpaid financing and supports both payment-method transitions', async () => fixture(async (tx, { app, base, userIds, create }) => {
    const purchase = await create();
    const path = `${base}/${purchase.id}`;
    const regenerated = (await write(request(app).patch(path), userIds[0]).send({ financing: { installmentCount: 10, installmentAmountCents: 11_000, firstInstallmentDate: '2026-12-31' } }).expect(200)).body.data;
    expect(regenerated.financing.installments).toHaveLength(10);
    expect(regenerated.financing.installments.slice(0, 3).map((row) => row.dueDate)).toEqual(['2026-12-31', '2027-01-31', '2027-02-28']);
    expect(regenerated.financing.installments.reduce((sum, row) => sum + row.expectedAmountCents, 0)).toBe(110_000);
    const upfront = (await write(request(app).patch(path), userIds[0]).send({ paymentMethod: 'UPFRONT', paymentDate: null, paidAmountCents: null }).expect(200)).body.data;
    expect(upfront).toMatchObject({ paymentMethod: 'UPFRONT', financing: null, paymentDate: null, paidAmountCents: null });
    expect(await tx.purchaseFinancing.count({ where: { purchaseId: purchase.id } })).toBe(0);
    const financed = (await write(request(app).patch(path), userIds[0]).send({ paymentMethod: 'FINANCED', financing: financingInput }).expect(200)).body.data;
    expect(financed.financing.installments).toHaveLength(20);
    expect(financed.financing.installments.every((row) => row.status === 'PLANNED')).toBe(true);
  }));

  it('recalculates principal when only purchase price changes and the unpaid financing terms remain valid', async () => fixture(async (_tx, { app, base, userIds, create }) => {
    const purchase = await create();
    const changed = (await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ totalCents: 130_000 }).expect(200)).body.data;
    expect(changed).toMatchObject({ totalCents: 130_000, financing: { downPaymentCents: 20_000, financedPrincipalCents: 110_000, financingTotalCents: 110_000, installmentCount: 20 } });
    expect(changed.financing.installments.map(({ dueDate, expectedAmountCents }) => ({ dueDate, expectedAmountCents }))).toEqual(purchase.financing.installments.map(({ dueDate, expectedAmountCents }) => ({ dueDate, expectedAmountCents })));
    expect(changed.financing.progress).toMatchObject({ costOfFinancingCents: 0, totalCostCents: 130_000, pendingCents: 130_000 });
  }));

  it('persists the maximum 1200 installments with exact cents and deferred schedule integrity', async () => fixture(async (tx, { create }) => {
    const purchase = await create({ totalCents: 1201, financing: { downPaymentCents: 0, installmentCount: 1200, installmentAmountCents: 1, firstInstallmentDate: '2000-01-31', financingTotalCents: 1201 } });
    expect(purchase.financing.installments).toHaveLength(1200);
    expect(purchase.financing.installments.at(-1)).toMatchObject({ sequence: 1200, dueDate: '2099-12-31', expectedAmountCents: 2 });
    expect(await tx.purchaseInstallment.count({ where: { purchaseFinancingId: purchase.financing.id } })).toBe(1200);
  }));

  it('requires explicit confirmation to remove a recorded upfront or deposit payment and preserves it in audit', async () => fixture(async (tx, { app, base, userIds, create }) => {
    const upfront = (await write(request(app).post(base), userIds[0]).send({ ...purchaseInput, paymentMethod: 'UPFRONT', paymentDate: '2026-09-17', paidAmountCents: 120_000 }).expect(201)).body.data;
    const next = { paymentMethod: 'FINANCED', financing: financingInput };
    await write(request(app).patch(`${base}/${upfront.id}`), userIds[0]).send(next).expect(409);
    await write(request(app).patch(`${base}/${upfront.id}`), userIds[0]).send({ ...next, confirmPaymentReset: true }).expect(200);
    const deposit = await create({ financing: { ...financingInput, downPaymentPaidAt: '2026-09-17' } });
    const cleared = { paymentMethod: 'UPFRONT', paymentDate: null, paidAmountCents: null };
    await write(request(app).patch(`${base}/${deposit.id}`), userIds[0]).send(cleared).expect(409);
    await write(request(app).patch(`${base}/${deposit.id}`), userIds[0]).send({ ...cleared, confirmPaymentReset: true }).expect(200);
    const logs = await tx.auditLog.findMany({ where: { resourceId: { in: [upfront.id, deposit.id] } } });
    expect(JSON.stringify(logs)).toContain('120000');
    expect(JSON.stringify(logs)).toContain('20000');
    expect(JSON.stringify(logs)).toContain('2026-09-17');
  }));

  it.each(['PERSONAL', 'SPLIT'])('respects %s privacy for reads and all installment writes, with no OWNER override', async (ownershipType) => fixture(async (_tx, { app, base, userIds, people, create, pay }) => {
    const ownership = ownershipType === 'PERSONAL'
      ? { ownershipType, personalPersonId: people[1].id }
      : { ownershipType, shares: [{ householdPersonId: people[1].id, shareBps: 6000 }, { householdPersonId: people[2].id, shareBps: 4000 }] };
    const purchase = await create(ownership, userIds[1]);
    const installment = purchase.financing.installments[0];
    const endpoint = `${base}/${purchase.id}/installments/${installment.id}`;
    const forbidden = ownershipType === 'PERSONAL' ? [userIds[0], userIds[2]] : [userIds[0]];
    for (const userId of forbidden) {
      await auth(request(app).get(`${base}/${purchase.id}`), userId).expect(404);
      await write(request(app).patch(`${base}/${purchase.id}`), userId).send({ financing: { provider: 'Invisible' } }).expect(404);
      await write(request(app).post(`${endpoint}/pay`), userId).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(404);
      await write(request(app).patch(`${endpoint}/payment`), userId).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(404);
      await write(request(app).delete(`${endpoint}/payment`), userId).send({ confirm: true }).expect(404);
    }
    const authorized = ownershipType === 'SPLIT' ? userIds[2] : userIds[1];
    const paid = await pay(purchase, installment, {}, authorized);
    expect(paid.financing.installments[0].status).toBe('PAID');
  }));

  it('household members can record common payments, but wrong purchase/item IDs and revoked/archived access cannot', async () => fixture(async (tx, { app, base, userIds, household, create, pay }) => {
    const purchase = await create();
    const other = await create();
    const installment = purchase.financing.installments[0];
    const data = { actualAmountCents: 5500, paidAt: '2026-09-17' };
    await write(request(app).post(`${base}/${other.id}/installments/${installment.id}/pay`), userIds[0]).send(data).expect(404);
    await write(request(app).post(`${base}/${purchase.id}/installments/${crypto.randomUUID()}/pay`), userIds[0]).send(data).expect(404);
    await pay(purchase, installment, {}, userIds[1]);
    await tx.householdUserAccess.update({ where: { householdId_userId: { householdId: household.id, userId: userIds[1] } }, data: { isActive: false, revokedAt: new Date() } });
    await write(request(app).post(`${base}/${purchase.id}/installments/${purchase.financing.installments[1].id}/pay`), userIds[1]).send(data).expect(404);
    await write(request(app).delete(`${base}/${purchase.id}`), userIds[0]).expect(200);
    await write(request(app).post(`${base}/${purchase.id}/installments/${purchase.financing.installments[1].id}/pay`), userIds[0]).send(data).expect(404);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: installment.id } })).status).toBe('PAID');
  }));

  it('ownership changes revoke installment access immediately', async () => fixture(async (_tx, { app, base, userIds, people, create, pay }) => {
    const purchase = await create();
    const installment = purchase.financing.installments[0];
    await write(request(app).patch(`${base}/${purchase.id}`), userIds[0]).send({ ownershipType: 'PERSONAL', personalPersonId: people[1].id }).expect(200);
    await write(request(app).post(`${base}/${purchase.id}/installments/${installment.id}/pay`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(404);
    expect((await pay(purchase, installment, {}, userIds[1])).financing.installments[0].status).toBe('PAID');
  }));

  it('does not allow future payment evidence or treating CANCELLED debt as a skippable installment', async () => fixture(async (tx, { app, base, userIds, create }) => {
    const purchase = await create();
    const installment = purchase.financing.installments[0];
    const endpoint = `${base}/${purchase.id}/installments/${installment.id}`;
    await write(request(app).post(`${endpoint}/pay`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '9999-12-31' }).expect(400);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: installment.id } })).status).toBe('PLANNED');
    await tx.purchaseInstallment.update({ where: { id: installment.id }, data: { status: 'CANCELLED' } });
    await write(request(app).post(`${endpoint}/pay`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(409);
    await write(request(app).patch(`${endpoint}/payment`), userIds[0]).send({ actualAmountCents: 5500, paidAt: '2026-09-17' }).expect(409);
    await write(request(app).delete(`${endpoint}/payment`), userIds[0]).send({ confirm: true }).expect(409);
  }));

  it('rejects invalid financing atomically without leaving partial purchases or payment audits', async () => fixture(async (tx, { app, base, userIds, household }) => {
    for (const change of [
      { downPaymentCents: -1 }, { downPaymentCents: 120_001 }, { installmentCount: 0 },
      { installmentAmountCents: 0 }, { installmentAmountCents: -1 }, { financingTotalCents: 99_999 },
      { installmentAmountCents: 100_000 }, { firstInstallmentDate: '2026-02-30' },
    ]) await write(request(app).post(base), userIds[0]).send({ ...financedPurchaseInput, financing: { ...financingInput, ...change } }).expect(400);
    expect(await tx.purchase.count({ where: { householdId: household.id } })).toBe(0);
    expect(await tx.auditLog.count({ where: { householdId: household.id } })).toBe(0);
  }));

  it('audit failure rolls back installment payment, correction, reversal and financing creation', async () => fixture(async (tx, { adapter, app, base, userIds, create, pay }) => {
    const purchase = await create();
    const installment = purchase.financing.installments[0];
    const endpoint = `${base}/${purchase.id}/installments/${installment.id}`;
    const failing = new Proxy(adapter, { get: (target, key) => key === '$transaction'
      ? (callback) => adapter.$transaction((inner) => callback(new Proxy(inner, { get: (modelTarget, model) => model === 'auditLog' ? { create: () => { throw new Error('Synthetic payment audit failure'); } } : Reflect.get(modelTarget, model) })))
      : Reflect.get(target, key) });
    const failingApp = paymentsTestApp(failing);
    const data = { actualAmountCents: 5500, paidAt: '2026-09-17' };
    await write(request(failingApp).post(`${endpoint}/pay`), userIds[0]).send(data).expect(500);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: installment.id } })).status).toBe('PLANNED');
    await pay(purchase, installment);
    await write(request(failingApp).patch(`${endpoint}/payment`), userIds[0]).send({ ...data, actualAmountCents: 6000 }).expect(500);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: installment.id } })).actualAmountCents).toBe(5500);
    await write(request(failingApp).delete(`${endpoint}/payment`), userIds[0]).send({ confirm: true }).expect(500);
    expect((await tx.purchaseInstallment.findUnique({ where: { id: installment.id } })).status).toBe('PAID');
    await write(request(failingApp).post(base), userIds[0]).send(financedPurchaseInput).expect(500);
    expect((await auth(request(app).get(base), userIds[0]).expect(200)).body.data).toHaveLength(1);
  }));

  it('payment changes update Finance without creating shadow expense or account records', async () => fixture(async (tx, { app, base, userIds, household, create, pay }) => {
    const prefix = `/api/households/${household.id}`;
    const endpoints = [`${prefix}/dashboard?date=2026-09-17`, `${prefix}/budget`, `${prefix}/calendar?view=MONTH&anchorDate=2026-09-17`];
    const read = async () => Promise.all(endpoints.map(async (endpoint) => (await auth(request(app).get(endpoint), userIds[0]).expect(200)).body.data));
    expect((await read())[0].monthlyProgress.common.usedCents).toBe(0);
    const purchase = await create({ financing: { ...financingInput, downPaymentPaidAt: '2026-09-17' } });
    const installment = purchase.financing.installments[0];
    await pay(purchase, installment);
    await write(request(app).patch(`${base}/${purchase.id}/installments/${installment.id}/payment`), userIds[0]).send({ actualAmountCents: 6000, paidAt: '2026-09-16' }).expect(200);
    const [paidDashboard, , paidCalendar] = await read();
    expect(paidDashboard.monthlyProgress.common).toMatchObject({ budgetCents: 20_000, usedCents: 26_000, overBudgetCents: 6000 });
    expect(paidCalendar.events).toHaveLength(1);
    expect(paidCalendar.events[0]).toMatchObject({ sourceType: 'PURCHASE_DOWN_PAYMENT', amountCents: 20_000, status: 'PAID' });
    await write(request(app).delete(`${base}/${purchase.id}/installments/${installment.id}/payment`), userIds[0]).send({ confirm: true }).expect(200);
    expect((await read())[0].monthlyProgress.common).toMatchObject({ budgetCents: 20_000, usedCents: 20_000, overBudgetCents: 0 });
    for (const model of ['oneTimeExpense', 'recurringExpense', 'utilityInvoice', 'householdAccount']) expect(await tx[model].count({ where: { householdId: household.id } })).toBe(0);
  }));

  it('database enforces financing ownership, principal, schedule, totals, uniqueness and real-payment consistency', async () => fixture(async (tx, { create }) => {
    const purchase = await create();
    const installment = purchase.financing.installments[0];
    const reject = async (operation) => {
      await tx.$executeRawUnsafe('SAVEPOINT invalid_purchase_payment');
      let error;
      try { await operation(); await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'); } catch (caught) { error = caught; }
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_purchase_payment');
      // PostgreSQL CHECK failures may surface as PrismaClientUnknownRequestError
      // without a stable P-code; still require a genuine database/Prisma error.
      expect(error?.name).toMatch(/^PrismaClient/);
    };
    await reject(() => tx.purchase.update({ where: { id: purchase.id }, data: { totalCents: 130_000 } }));
    await reject(() => tx.purchase.update({ where: { id: purchase.id }, data: { paymentMethod: 'UPFRONT' } }));
    await reject(() => tx.purchaseFinancing.delete({ where: { id: purchase.financing.id } }));
    await reject(() => tx.purchaseInstallment.delete({ where: { id: installment.id } }));
    await reject(() => tx.purchaseInstallment.update({ where: { id: installment.id }, data: { expectedAmountCents: 5501 } }));
    await reject(() => tx.purchaseInstallment.update({ where: { id: installment.id }, data: { dueDate: new Date('2026-10-16T00:00:00Z') } }));
    await reject(() => tx.purchaseInstallment.update({ where: { id: installment.id }, data: { status: 'PAID' } }));
    await reject(() => tx.purchaseInstallment.update({ where: { id: installment.id }, data: { status: 'PLANNED', actualAmountCents: 5500, paidAt: new Date('2026-09-17T00:00:00Z') } }));
    await reject(() => tx.purchaseInstallment.create({ data: { purchaseFinancingId: purchase.financing.id, sequence: 1, dueDate: new Date('2026-10-15T00:00:00Z'), expectedAmountCents: 5500 } }));
  }));
});
