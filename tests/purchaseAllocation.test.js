import { describe, expect, it } from 'vitest';
import { allocatePurchaseAmount, canRegisterPurchaseInstallment, createPurchaseAllocationSnapshot, firstPlannedPurchaseInstallment, purchaseAllocationSnapshotSchema } from '../src/modules/purchases/purchaseAllocation.js';
import { serializePurchase } from '../src/modules/purchases/warranty.js';

const household = { householdId: 'household', ownershipType: 'HOUSEHOLD' };
const personal = { ...household, ownershipType: 'PERSONAL', personalPersonId: 'pablo', personalPerson: { id: 'pablo', linkedUserId: 'user-pablo' } };
const split = (parts = [['pablo', 6000], ['natalia', 4000]]) => ({
  ...household, ownershipType: 'SPLIT', shares: parts.map(([id, shareBps]) => ({ householdPersonId: id, shareBps, householdPerson: { linkedUserId: `user-${id}` } })),
});
const planned = (sequence, status = 'PLANNED') => ({ id: `installment-${sequence}`, sequence, status, dueDate: new Date('2026-09-17T00:00:00Z'), expectedAmountCents: 100, actualAmountCents: status === 'PAID' ? 105 : null });

describe('purchase allocation snapshots and exact central distribution', () => {
  it('allocates household payments wholly to the common budget', () => {
    expect(allocatePurchaseAmount(90_000, household)).toEqual([{ scope: 'HOUSEHOLD', personalPersonId: null, linkedUserId: null, shareBps: 10000, amountCents: 90_000 }]);
  });
  it('allocates personal payments only to their person and frozen user link', () => {
    const snapshot = createPurchaseAllocationSnapshot(personal);
    expect(snapshot).toMatchObject({ version: 1, householdId: 'household', ownershipType: 'PERSONAL' });
    expect(allocatePurchaseAmount(123, snapshot)).toEqual([{ scope: 'PERSONAL', personalPersonId: 'pablo', linkedUserId: 'user-pablo', shareBps: 10000, amountCents: 123 }]);
    personal.personalPerson.linkedUserId = 'replacement-user';
    expect(allocatePurchaseAmount(123, snapshot)[0].linkedUserId).toBe('user-pablo');
    personal.personalPerson.linkedUserId = 'user-pablo';
  });
  it('keeps SPLIT personal, never converts it into common expenditure', () => {
    expect(allocatePurchaseAmount(10000, split())).toEqual([
      { scope: 'PERSONAL', personalPersonId: 'natalia', linkedUserId: 'user-natalia', shareBps: 4000, amountCents: 4000 },
      { scope: 'PERSONAL', personalPersonId: 'pablo', linkedUserId: 'user-pablo', shareBps: 6000, amountCents: 6000 },
    ]);
  });
  it.each([0, 1, 2, 3, 17, 100, 999, 1000, 2147483647])('preserves every cent for %i with stable input-order-independent remainders', (amount) => {
    const parts = [['person-c', 3334], ['person-a', 3333], ['person-b', 3333]];
    const left = allocatePurchaseAmount(amount, split(parts));
    const right = allocatePurchaseAmount(amount, split([...parts].reverse()));
    expect(left).toEqual(right);
    expect(left.reduce((sum, allocation) => sum + allocation.amountCents, 0)).toBe(amount);
  });
  it('gives equal-remainder cents to stable person IDs, not API share order', () => {
    expect(allocatePurchaseAmount(1, split([['z-last', 5000], ['a-first', 5000]]))).toMatchObject([
      { personalPersonId: 'a-first', amountCents: 1 }, { personalPersonId: 'z-last', amountCents: 0 },
    ]);
  });
  it('allocates budget and actual independently with historical weights', () => {
    const snapshot = createPurchaseAllocationSnapshot(split());
    expect(allocatePurchaseAmount(5000, snapshot).map((part) => part.amountCents)).toEqual([2000, 3000]);
    expect(allocatePurchaseAmount(5200, snapshot).map((part) => part.amountCents)).toEqual([2080, 3120]);
    expect(allocatePurchaseAmount(5000, household)[0].amountCents).toBe(5000);
    expect(snapshot.ownershipType).toBe('SPLIT');
  });
  it.each([
    { version: 2 }, { householdId: null }, { ownershipType: 'UNKNOWN' },
    { allocations: [] }, { allocations: [{ scope: 'HOUSEHOLD', personalPersonId: 'x', linkedUserId: null, shareBps: 10000 }] },
    { allocations: [{ scope: 'HOUSEHOLD', personalPersonId: null, linkedUserId: null, shareBps: 9999 }] },
  ])('rejects malformed snapshots rather than reallocating history: %j', (change) => {
    const snapshot = { ...createPurchaseAllocationSnapshot(household), ...change };
    expect(purchaseAllocationSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(() => allocatePurchaseAmount(100, snapshot)).toThrow();
  });
  it('allows historical manually managed people without a user link but never invents one', () => {
    expect(createPurchaseAllocationSnapshot({ ...personal, personalPerson: { linkedUserId: null } }).allocations[0].linkedUserId).toBeNull();
  });
});

describe('backend installment capabilities', () => {
  it('enables only the first globally planned installment, even when future', () => {
    const purchase = { paymentMethod: 'FINANCED', financing: { installments: [planned(3), planned(1, 'PAID'), planned(2)] } };
    expect(firstPlannedPurchaseInstallment(purchase).id).toBe('installment-2');
    expect(canRegisterPurchaseInstallment(purchase, purchase.financing.installments[0])).toBe(false);
    expect(canRegisterPurchaseInstallment(purchase, purchase.financing.installments[2])).toBe(true);
  });
  it('ignores cancelled obligations and never enables archived/paid installments', () => {
    const purchase = { paymentMethod: 'FINANCED', financing: { installments: [planned(1, 'CANCELLED'), planned(2)] } };
    expect(firstPlannedPurchaseInstallment(purchase).id).toBe('installment-2');
    expect(firstPlannedPurchaseInstallment({ ...purchase, archivedAt: new Date() })).toBeNull();
    expect(canRegisterPurchaseInstallment(purchase, planned(1, 'PAID'))).toBe(false);
  });
  it('never exposes frozen user links/snapshots in purchase detail or list JSON', () => {
    const snapshot = createPurchaseAllocationSnapshot(split());
    const purchase = {
      ...household, purchaseDate: '2026-09-17', paymentMethod: 'FINANCED', paymentDate: null, totalCents: 300,
      paymentAllocationSnapshot: snapshot, personalPerson: null, shares: [], items: [],
      financing: { downPaymentCents: 100, downPaymentPaidAt: '2026-09-17', downPaymentAllocationSnapshot: snapshot,
        firstInstallmentDate: '2026-09-17', installmentCount: 2, financingTotalCents: 200,
        installments: [planned(1, 'PAID'), { ...planned(2), paymentAllocationSnapshot: snapshot }] },
    };
    for (const list of [false, true]) {
      const result = serializePurchase(purchase, '2026-09-17', { list });
      expect(result).not.toHaveProperty('paymentAllocationSnapshot');
      expect(result.financing).not.toHaveProperty('downPaymentAllocationSnapshot');
      expect(JSON.stringify(result)).not.toContain('AllocationSnapshot');
      expect(JSON.stringify(result)).not.toContain('linkedUserId');
      if (!list) expect(result.financing.installments.map((item) => item.canRegisterPayment)).toEqual([false, true]);
    }
  });
});
