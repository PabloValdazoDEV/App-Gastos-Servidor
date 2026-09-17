import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authenticatedPayment as auth, mutablePayment as write, paymentsTestApp } from './helpers/purchasePaymentsFixtures.js';

const householdId = '80000000-0000-4000-8000-000000000001';
const purchaseId = '80000000-0000-4000-8000-000000000002';
const installmentId = '80000000-0000-4000-8000-000000000003';
const userId = '80000000-0000-4000-8000-000000000004';
const base = `/api/households/${householdId}/purchases/${purchaseId}/installments/${installmentId}`;
const routes = [
  ['post', 'pay', { actualAmountCents: 5500, paidAt: '2026-09-17' }],
  ['patch', 'payment', { actualAmountCents: 5500, paidAt: '2026-09-17' }],
  ['delete', 'payment', { confirm: true }],
];
function fixture() {
  const prisma = {
    householdUserAccess: { findFirst: vi.fn(async () => ({ role: 'MEMBER', household: { id: householdId, timezone: 'Europe/Madrid', isActive: true } })) },
    purchase: { findFirst: vi.fn(async () => null), update: vi.fn() },
    purchaseInstallment: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  prisma.$transaction = vi.fn((operation) => operation(prisma));
  return { app: paymentsTestApp(prisma), prisma };
}

describe('purchase installment route protections', () => {
  it.each(routes)('requires authentication before %s /%s', async (method, suffix, payload) => {
    const { app, prisma } = fixture();
    await request(app)[method](`${base}/${suffix}`).send(payload).expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.householdUserAccess.findFirst).not.toHaveBeenCalled();
  });
  it.each(routes)('requires CSRF before %s /%s', async (method, suffix, payload) => {
    const { app, prisma } = fixture();
    await auth(request(app)[method](`${base}/${suffix}`), userId).send(payload).expect(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(routes)('authorizes %s /%s inside the Serializable write transaction, never mutating an invisible parent', async (method, suffix, payload) => {
    const { app, prisma } = fixture();
    await write(request(app)[method](`${base}/${suffix}`), userId).send(payload).expect(404);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(prisma.householdUserAccess.findFirst).toHaveBeenCalled();
    expect(prisma.purchase.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: purchaseId, householdId, archivedAt: null, OR: expect.any(Array) }) }));
    expect(prisma.purchaseInstallment.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(routes)('validates UUIDs before %s /%s enters database work', async (method, suffix, payload) => {
    const { app, prisma } = fixture();
    await write(request(app)[method](`${base.replace(installmentId, 'not-a-uuid')}/${suffix}`), userId).send(payload).expect(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['post', 'pay', { status: 'SKIPPED', actualAmountCents: 5500, paidAt: '2026-09-17' }],
    ['post', 'pay', { actualAmountCents: 0, paidAt: '2026-09-17' }],
    ['patch', 'payment', { actualAmountCents: 5500 }],
    ['delete', 'payment', {}],
    ['delete', 'payment', { confirm: false }],
  ])('rejects invalid payment body %s /%s %j before writing', async (method, suffix, payload) => {
    const { app, prisma } = fixture();
    await write(request(app)[method](`${base}/${suffix}`), userId).send(payload).expect(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.purchaseInstallment.update).not.toHaveBeenCalled();
  });
});
