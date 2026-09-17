import { z } from 'zod';
import { splitAmount } from '../../services/money.service.js';

export const PURCHASE_ALLOCATION_VERSION = 1;
const identifier = z.string().min(1);
const allocationSchema = z.object({
  scope: z.enum(['HOUSEHOLD', 'PERSONAL']),
  personalPersonId: identifier.nullable(),
  linkedUserId: identifier.nullable(),
  shareBps: z.number().int().min(1).max(10_000),
}).strict();
export const purchaseAllocationSnapshotSchema = z.object({
  version: z.literal(PURCHASE_ALLOCATION_VERSION), householdId: identifier,
  ownershipType: z.enum(['HOUSEHOLD', 'PERSONAL', 'SPLIT']),
  allocations: z.array(allocationSchema).min(1).max(100),
}).strict().superRefine((snapshot, context) => {
  const allocations = snapshot.allocations;
  const common = snapshot.ownershipType === 'HOUSEHOLD';
  if (allocations.reduce((sum, part) => sum + part.shareBps, 0) !== 10_000
    || new Set(allocations.map((part) => part.personalPersonId)).size !== allocations.length
    || (snapshot.ownershipType === 'SPLIT' ? allocations.length < 2 : allocations.length !== 1)
    || allocations.some((part) => common
      ? part.scope !== 'HOUSEHOLD' || part.personalPersonId !== null || part.linkedUserId !== null
      : part.scope !== 'PERSONAL' || !part.personalPersonId)) {
    context.addIssue({ code: 'custom', message: 'El reparto histórico de la compra no es válido.' });
  }
});

// Stable identity + weights, not amounts: expected and actual are allocated
// independently using the SAME historical weights and deterministic remainder.
// linkedUserId is captured too: relinking a person must not transfer old money.
export function createPurchaseAllocationSnapshot(purchase) {
  let allocations;
  if (purchase.ownershipType === 'HOUSEHOLD') {
    allocations = [{ scope: 'HOUSEHOLD', personalPersonId: null, linkedUserId: null, shareBps: 10_000 }];
  } else if (purchase.ownershipType === 'PERSONAL') {
    allocations = [{ scope: 'PERSONAL', personalPersonId: purchase.personalPersonId,
      linkedUserId: purchase.personalPerson?.linkedUserId ?? null, shareBps: 10_000 }];
  } else {
    allocations = (purchase.shares ?? []).map((share) => ({
      scope: 'PERSONAL', personalPersonId: share.householdPersonId,
      linkedUserId: share.householdPerson?.linkedUserId ?? null, shareBps: share.shareBps,
    }));
  }
  return purchaseAllocationSnapshotSchema.parse({
    version: PURCHASE_ALLOCATION_VERSION, householdId: purchase.householdId,
    ownershipType: purchase.ownershipType,
    allocations: allocations.sort((left, right) => (left.personalPersonId ?? '').localeCompare(right.personalPersonId ?? '')),
  });
}

export function allocatePurchaseAmount(amountCents, snapshotOrPurchase) {
  const snapshot = snapshotOrPurchase && Object.hasOwn(snapshotOrPurchase, 'version')
    ? purchaseAllocationSnapshotSchema.parse(snapshotOrPurchase)
    : createPurchaseAllocationSnapshot(snapshotOrPurchase);
  const allocations = [...snapshot.allocations].sort((left, right) => (left.personalPersonId ?? '').localeCompare(right.personalPersonId ?? ''));
  const amounts = splitAmount(amountCents, allocations.map((part, index) => ({
    id: part.personalPersonId ?? 'HOUSEHOLD', contributionBps: part.shareBps, sortOrder: index,
  })));
  return allocations.map((part, index) => ({ ...part, amountCents: amounts[index].amountCents }));
}

export function firstPlannedPurchaseInstallment(purchase) {
  if (purchase.archivedAt || purchase.paymentMethod !== 'FINANCED') return null;
  return (purchase.financing?.installments ?? []).filter((installment) => installment.status === 'PLANNED')
    .reduce((first, installment) => !first || installment.sequence < first.sequence ? installment : first, null);
}

export function canRegisterPurchaseInstallment(purchase, installment) {
  return Boolean(installment?.status === 'PLANNED' && firstPlannedPurchaseInstallment(purchase)?.id === installment.id);
}
