import { requireHouseholdRole } from '../households/authorization.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { ownershipSchema } from './purchases.schemas.js';
import { householdToday, serializePurchase, warrantyFields } from './warranty.js';
import { PAYMENT_INPUT_FIELDS, preparePurchasePayment } from './purchasePayments.js';
import { purchasePaymentAllocationsForAudit, stampPurchasePaymentAllocations } from './paymentAllocation.service.js';

export const purchaseInclude = {
  personalPerson: { select: { id: true, name: true, linkedUserId: true } },
  shares: { include: { householdPerson: { select: { id: true, name: true, linkedUserId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  financing: { include: { installments: { orderBy: { sequence: 'asc' } } } },
};
const omit = (object, fields) => Object.fromEntries(Object.entries(object).filter(([key]) => !fields.includes(key)));
const sameOwnership = (left, right) => {
  if (!left || !right || left.ownershipType !== right.ownershipType || left.personalPersonId !== right.personalPersonId) return false;
  const key = (shares) => JSON.stringify(shares.map(({ householdPersonId, shareBps }) => [householdPersonId, shareBps])
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)));
  return key(left.shares ?? []) === key(right.shares ?? []);
};

export const visiblePurchaseWhere = (userId) => ({ OR: [
  { ownershipType: 'HOUSEHOLD' },
  { ownershipType: 'PERSONAL', personalPerson: { linkedUserId: userId } },
  { ownershipType: 'SPLIT', shares: { some: { householdPerson: { linkedUserId: userId } } } },
] });

export function canViewPurchase(purchase, userId) {
  return purchase.ownershipType === 'HOUSEHOLD'
    || (purchase.ownershipType === 'PERSONAL' && purchase.personalPerson?.linkedUserId === userId)
    || (purchase.ownershipType === 'SPLIT' && purchase.shares.some((share) => share.householdPerson.linkedUserId === userId));
}

async function visiblePurchase(database, { householdId, purchaseId, userId }) {
  const purchase = await database.purchase.findFirst({
    where: { id: purchaseId, householdId, archivedAt: null, ...visiblePurchaseWhere(userId) },
    include: purchaseInclude,
  });
  if (!purchase) throw createDomainError(404, 'PURCHASE_NOT_FOUND', 'No se encontró la compra solicitada.');
  return purchase;
}

// Documents inherit precisely the same active-household and purchase visibility
// checks, including archived purchases and no OWNER/ADMIN privacy exception.
export async function requireVisiblePurchase(database, context) {
  await requireHouseholdRole(database, context);
  return visiblePurchase(database, context);
}

export async function normalizeOwnership(database, householdId, input, existing) {
  const ownershipType = input.ownershipType ?? existing?.ownershipType ?? 'HOUSEHOLD';
  const source = ownershipSchema.parse({
    ownershipType,
    personalPersonId: Object.hasOwn(input, 'personalPersonId') ? input.personalPersonId
      : ownershipType === existing?.ownershipType ? existing?.personalPersonId : null,
    shares: input.shares ?? (ownershipType === existing?.ownershipType ? existing?.shares.map(({ householdPersonId, shareBps }) => ({ householdPersonId, shareBps })) : []),
  });
  const personalPersonId = ownershipType === 'PERSONAL' ? source.personalPersonId : null;
  const shares = ownershipType === 'SPLIT' ? source.shares.map(({ householdPersonId, shareBps }) => ({ householdPersonId, shareBps })) : [];
  const personIds = ownershipType === 'PERSONAL' ? [personalPersonId] : shares.map((share) => share.householdPersonId);
  const ownershipChanged = !sameOwnership(existing, { ownershipType, personalPersonId, shares });
  if (personIds.length && ownershipChanged) {
    const people = await database.householdPerson.findMany({
      where: { id: { in: personIds }, householdId, isActive: true, archivedAt: null }, select: { id: true },
    });
    if (people.length !== personIds.length) {
      throw createDomainError(400, 'PURCHASE_PERSON_INVALID', 'Selecciona personas activas que pertenezcan a este hogar.');
    }
  }
  return { ownershipType, personalPersonId, shares };
}

function itemData(input, purchaseDate) {
  const fields = omit(input, ['warrantyDurationMonths', 'warrantyEndsAt']);
  return { ...fields, ...warrantyFields(input, purchaseDate) };
}

async function audit(database, context, action, resourceId, metadata) {
  await createAuditLog(database, {
    actorUserId: context.userId, householdId: context.householdId, action,
    resourceType: action.startsWith('PURCHASE_ITEM_') ? 'PurchaseItem' : 'Purchase', resourceId, metadata,
  });
}

function responseFor(purchase, context, household) {
  // Changing ownership may legitimately remove the actor's access. Do not return
  // an invisible resource (including the other person's identifiers) afterwards.
  if (!canViewPurchase(purchase, context.userId)) return { id: purchase.id, accessRevoked: true };
  return serializePurchase(purchase, householdToday(household.timezone));
}

async function auditPaymentChanges(database, context, payment, purchase, existing) {
  const metadata = {
    before: payment.before ? { ...payment.before, allocationSnapshots: purchasePaymentAllocationsForAudit(existing) } : null,
    after: { ...payment.after, allocationSnapshots: purchasePaymentAllocationsForAudit(purchase) },
    confirmedReset: payment.resetConfirmed,
  };
  if (payment.methodChanged) await audit(database, context, 'PURCHASE_PAYMENT_METHOD_CHANGED', purchase.id, metadata);
  if (payment.financingChanged) {
    await createAuditLog(database, {
      actorUserId: context.userId, householdId: context.householdId,
      action: existing?.financing ? 'PURCHASE_FINANCING_CHANGED' : 'PURCHASE_FINANCING_CREATED',
      resourceType: 'PurchaseFinancing', resourceId: purchase.financing?.id ?? existing?.financing?.id ?? purchase.id,
      metadata: { purchaseId: purchase.id, ...metadata },
    });
  } else if (payment.paymentChanged && (existing || payment.purchaseFields.paymentDate)) {
    await audit(database, context, 'PURCHASE_PAYMENT_CHANGED', purchase.id, metadata);
  }
}

export async function listPurchases(prisma, context) {
  const { household } = await requireHouseholdRole(prisma, context);
  const purchases = await prisma.purchase.findMany({
    where: { householdId: context.householdId, archivedAt: null, ...visiblePurchaseWhere(context.userId) },
    include: {
      ...purchaseInclude,
      // Summary arithmetic needs these fields only; do not load payment notes
      // or full installment history for the list. The existing unpaginated
      // purchases contract is unchanged (no new global finance queries).
      financing: { include: { installments: { select: {
        id: true, sequence: true, dueDate: true, expectedAmountCents: true, actualAmountCents: true, status: true,
      } } } },
    }, orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  });
  const today = householdToday(household.timezone);
  return purchases.map((purchase) => serializePurchase(purchase, today, { list: true }));
}

export async function getPurchase(prisma, context) {
  const { household } = await requireHouseholdRole(prisma, context);
  return serializePurchase(await visiblePurchase(prisma, context), householdToday(household.timezone));
}

export async function createPurchase(prisma, context, input) {
  return runSerializableTransaction(prisma, (database) => createPurchaseInTransaction(database, context, input));
}

export async function createPurchaseInTransaction(database, context, input) {
    const { household } = await requireHouseholdRole(database, context);
    const { shares, ...ownership } = await normalizeOwnership(database, context.householdId, input);
    const items = input.singleProduct ? input.items.map((item) => ({ ...item, priceCents: input.totalCents })) : input.items;
    const payment = preparePurchasePayment(input, undefined, householdToday(household.timezone));
    await stampPurchasePaymentAllocations(database, context, { ...ownership, shares }, payment);
    const metadata = omit(input, ['items', 'personalPersonId', 'ownershipType', 'shares', ...PAYMENT_INPUT_FIELDS]);
    const purchase = await database.purchase.create({
      data: {
        ...metadata, householdId: context.householdId, ...ownership, ...payment.purchaseFields,
        shares: { create: shares }, items: { create: items.map((item) => itemData(item, input.purchaseDate)) },
        ...(payment.financingFields ? { financing: { create: { ...payment.financingFields, installments: { create: payment.installments } } } } : {}),
      }, include: purchaseInclude,
    });
    await audit(database, context, 'PURCHASE_CREATED', purchase.id);
    await auditPaymentChanges(database, context, payment, purchase);
    return responseFor(purchase, context, household);
}

export async function updatePurchase(prisma, context, input) {
  return runSerializableTransaction(prisma, (database) => updatePurchaseInTransaction(database, context, input));
}

// Shared by ordinary edits and explicitly reviewed document data. The caller
// owns the Serializable transaction; this preserves all payment/warranty audits.
export async function updatePurchaseInTransaction(database, context, input) {
    const { household } = await requireHouseholdRole(database, context);
    const existing = await visiblePurchase(database, context);
    const { shares, ...ownership } = await normalizeOwnership(database, context.householdId, input, existing);
    const payment = preparePurchasePayment(input, existing, householdToday(household.timezone));
    await stampPurchasePaymentAllocations(database, context, { ...ownership, shares }, payment, existing);
    const metadata = omit(input, ['personalPersonId', 'ownershipType', 'shares', ...PAYMENT_INPUT_FIELDS]);
    if (input.purchaseDate && input.purchaseDate.getTime() !== existing.purchaseDate.getTime()) {
      for (const item of existing.items.filter((item) => item.warrantySource === 'DURATION')) {
        await database.purchaseItem.update({ where: { id: item.id }, data: warrantyFields({ warrantyDurationMonths: item.warrantyDurationMonths }, input.purchaseDate) });
      }
    }
    const ownershipChanged = !sameOwnership(existing, { ...ownership, shares });
    if (ownershipChanged) await database.purchaseShare.deleteMany({ where: { purchaseId: context.purchaseId } });
    // Parent writes also serialize this operation with installment payment and
    // document/item writes. Every payment authorization is checked in this tx.
    await database.purchase.update({ where: { id: existing.id }, data: { updatedAt: new Date() } });
    if (existing.financing && !payment.financingFields) {
      await database.purchaseFinancing.delete({ where: { id: existing.financing.id } });
    } else if (payment.financingFields) {
      if (!existing.financing) {
        await database.purchaseFinancing.create({ data: {
          purchaseId: existing.id, ...payment.financingFields, installments: { create: payment.installments },
        } });
      } else if (payment.financingChanged) {
        if (payment.structureChanged) await database.purchaseInstallment.deleteMany({ where: { purchaseFinancingId: existing.financing.id } });
        await database.purchaseFinancing.update({ where: { id: existing.financing.id }, data: {
          ...payment.financingFields,
          ...(payment.structureChanged ? { installments: { create: payment.installments } } : {}),
        } });
      }
    }
    if (existing.singleProduct && input.totalCents != null) {
      await database.purchaseItem.updateMany({ where: { purchaseId: existing.id }, data: { priceCents: input.totalCents } });
    }
    const purchase = await database.purchase.update({
      where: { id: context.purchaseId }, data: {
        ...metadata, ...ownership, ...payment.purchaseFields,
        ...(ownershipChanged ? { shares: { create: shares } } : {}),
      }, include: purchaseInclude,
    });
    await audit(database, context, 'PURCHASE_CHANGED', purchase.id);
    await auditPaymentChanges(database, context, payment, purchase, existing);
    return responseFor(purchase, context, household);
}

export async function archivePurchase(prisma, context) {
  return runSerializableTransaction(prisma, async (database) => {
    await requireHouseholdRole(database, context);
    await visiblePurchase(database, context);
    const purchase = await database.purchase.update({ where: { id: context.purchaseId }, data: { archivedAt: new Date() } });
    await audit(database, context, 'PURCHASE_ARCHIVED', purchase.id);
    return { id: purchase.id, archivedAt: purchase.archivedAt };
  });
}

export async function mutatePurchaseItem(prisma, context, operation, input) {
  return runSerializableTransaction(prisma, async (database) => {
    const { household } = await requireHouseholdRole(database, context);
    const purchase = await visiblePurchase(database, context);
    const item = purchase.items.find((candidate) => candidate.id === context.itemId);
    if (operation !== 'create' && !item) throw createDomainError(404, 'PURCHASE_ITEM_NOT_FOUND', 'No se encontró el producto solicitado.');
    if (operation === 'delete' && purchase.items.length <= 1) {
      throw createDomainError(409, 'PURCHASE_LAST_ITEM', 'La compra debe conservar al menos un producto. Puedes archivar la compra completa.');
    }
    if (operation === 'create' && purchase.singleProduct) throw createDomainError(400, 'PURCHASE_SINGLE_PRODUCT', 'Esta compra corresponde a un producto. Crea otra compra para añadir un producto distinto.');
    if (operation === 'create' && purchase.items.length >= 50) throw createDomainError(400, 'PURCHASE_ITEMS_LIMIT', 'Una compra admite como máximo 50 productos.');
    // All item writes also write their parent, preventing concurrent last-item
    // deletes and a date edit racing a warranty edit (Serializable retries).
    await database.purchase.update({ where: { id: purchase.id }, data: { updatedAt: new Date() } });
    let resourceId = context.itemId;
    if (operation === 'create') {
      const created = await database.purchaseItem.create({ data: { purchaseId: purchase.id, ...itemData(input, purchase.purchaseDate) } });
      resourceId = created.id;
    } else if (operation === 'update') {
      const metadata = omit(input, ['warrantyDurationMonths', 'warrantyEndsAt']);
      if (purchase.singleProduct) metadata.priceCents = purchase.totalCents;
      const hasWarranty = ['warrantyEndsAt', 'warrantyDurationMonths'].some((field) => Object.hasOwn(input, field));
      await database.purchaseItem.update({ where: { id: item.id }, data: { ...metadata, ...(hasWarranty ? warrantyFields(input, purchase.purchaseDate) : {}) } });
    } else {
      await database.purchaseItem.delete({ where: { id: item.id } });
    }
    const actions = { create: 'PURCHASE_ITEM_CREATED', update: 'PURCHASE_ITEM_CHANGED', delete: 'PURCHASE_ITEM_DELETED' };
    await audit(database, context, actions[operation], resourceId, { purchaseId: purchase.id });
    return serializePurchase(await visiblePurchase(database, context), householdToday(household.timezone));
  });
}
