import request from 'supertest';
import { expect } from 'vitest';
import { authenticatedPayment as auth, mutablePayment as write, paymentsTestApp, createFinancedPurchase, purchaseInput } from './purchasePaymentsFixtures.js';

export async function withPurchaseFinanceFixture(database, operation) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('Only local PostgreSQL is allowed.');
  const userIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const rollback = new Error('ROLLBACK_PURCHASE_FINANCE');
  try {
    await database.$transaction(async (tx) => {
      await tx.user.createMany({ data: userIds.map((id) => ({ id, name: 'Finance purchase test', email: `${id}@purchase-finance.invalid` })) });
      const household = await tx.household.create({ data: { name: 'Purchase finance', ownerUserId: userIds[0], safetyMarginBps: 2000, currentBalanceCents: 10_000 } });
      const people = [];
      for (const [index, userId] of userIds.entries()) {
        await tx.householdUserAccess.create({ data: { householdId: household.id, userId, role: index === 0 ? 'OWNER' : 'MEMBER' } });
        people.push(await tx.householdPerson.create({ data: { householdId: household.id, linkedUserId: userId, name: ['Pablo', 'Natalia', 'Otro'][index], contributionBps: [6000, 4000, 0][index] } }));
      }
      let sequence = 0;
      const adapter = new Proxy(tx, { get: (target, key) => key === '$transaction' ? async (callback) => {
        const savepoint = `purchase_finance_${sequence++}`;
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
      const prefix = `/api/households/${household.id}`;
      const base = `${prefix}/purchases`;
      const read = async (path, viewer = 0) => (await auth(request(app).get(`${prefix}${path}`), userIds[viewer]).expect(200)).body.data;
      const dashboard = (date = '2026-09-17', viewer = 0) => read(`/dashboard?date=${date}`, viewer);
      const calendar = (date = '2026-09-17', viewer = 0) => read(`/calendar?view=MONTH&anchorDate=${date}`, viewer);
      const create = (input = {}, viewer = 0) => createFinancedPurchase(app, base, userIds[viewer], input);
      const upfront = async (input = {}, viewer = 0) => (await write(request(app).post(base), userIds[viewer]).send({ ...purchaseInput, paymentDate: '2026-09-17', paidAmountCents: 90_000, totalCents: 90_000, ...input }).expect(201)).body.data;
      const patch = async (purchase, input, viewer = 0) => (await write(request(app).patch(`${base}/${purchase.id}`), userIds[viewer]).send(input).expect(200)).body.data;
      const pay = async (purchase, sequenceNumber = 1, input = {}, viewer = 0) => (await write(request(app).post(`${base}/${purchase.id}/installments/${purchase.financing.installments[sequenceNumber - 1].id}/pay`), userIds[viewer]).send({ actualAmountCents: purchase.financing.installments[sequenceNumber - 1].expectedAmountCents, paidAt: '2026-09-17', ...input }).expect(200)).body.data;
      await operation(tx, { app, adapter, base, prefix, household, people, userIds, read, dashboard, calendar, create, upfront, patch, pay });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw rollback;
    }, { timeout: 45_000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally { expect(await database.user.count({ where: { id: { in: userIds } } })).toBe(0); }
}
