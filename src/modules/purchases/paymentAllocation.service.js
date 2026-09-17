import { Prisma } from '@prisma/client';
import { createDomainError } from '../household-domain/domainError.js';
import { createPurchaseAllocationSnapshot, purchaseAllocationSnapshotSchema } from './purchaseAllocation.js';

export function retainPurchasePaymentAllocation(snapshot) {
  if (!snapshot) throw createDomainError(409, 'PURCHASE_PAYMENT_ALLOCATION_MISSING', 'El reparto histórico de este pago necesita revisión. No se ha modificado el pago.');
  return purchaseAllocationSnapshotSchema.parse(snapshot);
}

async function allocationForOwnership(database, context, ownership) {
  const personIds = ownership.ownershipType === 'PERSONAL' ? [ownership.personalPersonId]
    : ownership.ownershipType === 'SPLIT' ? ownership.shares.map((share) => share.householdPersonId) : [];
  const people = personIds.length ? await database.householdPerson.findMany({
    where: { id: { in: personIds }, householdId: context.householdId },
    select: { id: true, linkedUserId: true },
  }) : [];
  if (people.length !== personIds.length) throw createDomainError(400, 'PURCHASE_PERSON_INVALID', 'El reparto debe pertenecer al hogar de la compra.');
  return createPurchaseAllocationSnapshot({
    ...ownership, householdId: context.householdId,
    personalPerson: people.find((person) => person.id === ownership.personalPersonId),
    shares: (ownership.shares ?? []).map((share) => ({ ...share, householdPerson: people.find((person) => person.id === share.householdPersonId) })),
  });
}

// Add persistence fields after pure validation. Corrections retain old weights
// and user links even if current ownership changed. Only an explicit reset
// clears the snapshot; a subsequent new payment captures current ownership.
export async function stampPurchasePaymentAllocations(database, context, ownership, payment, existing) {
  let current;
  const capture = async () => current ??= await allocationForOwnership(database, context, ownership);
  payment.purchaseFields.paymentAllocationSnapshot = payment.purchaseFields.paymentDate
    ? existing?.paymentDate
      ? retainPurchasePaymentAllocation(existing.paymentAllocationSnapshot)
      : await capture()
    : Prisma.DbNull;
  if (payment.financingFields) {
    payment.financingFields.downPaymentAllocationSnapshot = payment.financingFields.downPaymentPaidAt
      ? existing?.financing?.downPaymentPaidAt
        ? retainPurchasePaymentAllocation(existing.financing.downPaymentAllocationSnapshot)
        : await capture()
      : Prisma.DbNull;
  }
}

export const purchasePaymentAllocationsForAudit = (purchase) => ({
  upfront: purchase?.paymentAllocationSnapshot ?? null,
  downPayment: purchase?.financing?.downPaymentAllocationSnapshot ?? null,
});
