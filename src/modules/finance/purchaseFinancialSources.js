import { addCalendarDays, compareCivilDates, toCivilDate, toIsoDate } from '../../services/date.service.js';
import { allocatePurchaseAmount, createPurchaseAllocationSnapshot } from '../purchases/purchaseAllocation.js';
import { canViewPurchase } from '../purchases/purchases.service.js';

const inRange = (value, from, to) => value != null && compareCivilDates(value, from) >= 0 && compareCivilDates(value, to) <= 0;
const personSelect = { id: true, name: true, linkedUserId: true };

/** One canonical purchase -> financial-source path. PAID ownership is historical;
 * scheduled ownership is live. Never expose other people's allocations, payment
 * notes, snapshots, serials or whole SPLIT amounts to the finance API. */
export function buildPurchaseFinancialSources(purchases, {
  actorUserId, from, to, firstPendingByFinancing = new Map(), includeOverdue = false,
  personalPersonIdForAllocation = (part) => part.personalPersonId,
}) {
  const sources = [];
  for (const purchase of purchases) {
    const currentlyVisible = !actorUserId || canViewPurchase(purchase, actorUserId);
    const canAccessPurchase = currentlyVisible && !purchase.archivedAt;
    const title = canAccessPurchase ? purchase.items?.[0]?.name ?? purchase.merchant ?? 'Compra' : 'Pago histórico de compra';
    const add = ({ sourceType, sourceId, budgetDate, dueDate = budgetDate, paidAt = null, expectedAmountCents,
      actualAmountCents = null, snapshot = null, installmentId = null, sequence = null, installmentCount = null, firstPending = false }) => {
      const status = paidAt ? 'PAID' : 'PLANNED';
      if (status === 'PLANNED' && !canAccessPurchase) return;
      if (!inRange(budgetDate, from, to) && !inRange(paidAt, from, to)
        && !(includeOverdue && status === 'PLANNED' && compareCivilDates(dueDate, from) < 0)) return;
      // A migrated/materialized paid allocation is mandatory. Falling back to
      // current ownership would silently rewrite historical personal spending.
      const allocation = status === 'PAID' ? snapshot : createPurchaseAllocationSnapshot(purchase);
      if (!allocation) throw new Error('Un pago de compra requiere su reparto histórico.');
      if (allocation.householdId !== purchase.householdId) throw new Error('El reparto histórico no pertenece al hogar de la compra.');
      const expected = allocatePurchaseAmount(expectedAmountCents, allocation);
      const actual = actualAmountCents == null ? [] : allocatePurchaseAmount(actualAmountCents, allocation);
      const key = (part) => `${part.scope}:${part.personalPersonId ?? 'HOUSEHOLD'}`;
      const actualByScope = new Map(actual.map((part) => [key(part), part.amountCents]));
      const suffix = sourceType === 'PURCHASE_UPFRONT' ? 'Al contado'
        : sourceType === 'PURCHASE_DOWN_PAYMENT' ? 'Entrada' : `Cuota ${sequence}/${installmentCount}`;
      for (const part of expected) {
        if (actorUserId && part.scope !== 'HOUSEHOLD' && part.linkedUserId !== actorUserId) continue;
        const personalPersonId = part.scope === 'PERSONAL' ? personalPersonIdForAllocation(part) : null;
        sources.push({
          id: `${sourceType}:${sourceId}:${key(part)}`, sourceType, purchaseId: purchase.id,
          installmentId, sequence, installmentCount, name: `${title} · ${suffix}`,
          scope: part.scope, personalPersonId: personalPersonId ?? null,
          ownershipType: allocation.ownershipType, shareBps: part.shareBps,
          expectedAmountCents: part.amountCents,
          actualAmountCents: actualAmountCents == null ? null : actualByScope.get(key(part)) ?? 0,
          budgetDate: toIsoDate(budgetDate), dueDate: toIsoDate(dueDate), paidAt: paidAt ? toIsoDate(paidAt) : null,
          status, canAccessPurchase,
          canRegisterPayment: sourceType === 'PURCHASE_INSTALLMENT' && status === 'PLANNED' && firstPending && canAccessPurchase,
          canEditPayment: sourceType === 'PURCHASE_INSTALLMENT' && status === 'PAID' && canAccessPurchase,
        });
      }
    };
    if (purchase.paymentMethod === 'UPFRONT' && purchase.paymentDate && purchase.paidAmountCents != null) {
      add({ sourceType: 'PURCHASE_UPFRONT', sourceId: purchase.id, budgetDate: purchase.paymentDate,
        paidAt: purchase.paymentDate, expectedAmountCents: purchase.paidAmountCents,
        actualAmountCents: purchase.paidAmountCents, snapshot: purchase.paymentAllocationSnapshot });
    }
    const financing = purchase.financing;
    if (purchase.paymentMethod !== 'FINANCED' || !financing) continue;
    if (financing.downPaymentCents > 0) {
      add({ sourceType: 'PURCHASE_DOWN_PAYMENT', sourceId: financing.id,
        budgetDate: financing.downPaymentPaidAt ?? purchase.purchaseDate, paidAt: financing.downPaymentPaidAt,
        expectedAmountCents: financing.downPaymentCents,
        actualAmountCents: financing.downPaymentPaidAt ? financing.downPaymentCents : null,
        snapshot: financing.downPaymentAllocationSnapshot });
    }
    const firstPending = firstPendingByFinancing.has(financing.id)
      ? firstPendingByFinancing.get(financing.id)
      : financing.installments?.filter((item) => item.status === 'PLANNED').sort((left, right) => left.sequence - right.sequence)[0]?.id;
    for (const installment of financing.installments ?? []) {
      if (!['PLANNED', 'PAID'].includes(installment.status)) continue;
      add({ sourceType: 'PURCHASE_INSTALLMENT', sourceId: installment.id, installmentId: installment.id,
        sequence: installment.sequence, installmentCount: financing.installmentCount,
        budgetDate: installment.dueDate, paidAt: installment.status === 'PAID' ? installment.paidAt : null,
        expectedAmountCents: installment.expectedAmountCents,
        actualAmountCents: installment.status === 'PAID' ? installment.actualAmountCents : null,
        snapshot: installment.paymentAllocationSnapshot, firstPending: installment.id === firstPending });
    }
  }
  return sources;
}

export async function loadPurchaseFinancialSources(database, { householdId, actorUserId, from, to, includeOverdue = false }) {
  // Older calculator-only fixtures have no purchase repository. Production
  // always has one; no persisted shadow expenses or generic transactions exist.
  if (!database.purchase?.findMany) return [];
  const range = { gte: toCivilDate(from), lt: addCalendarDays(to, 1) };
  const pendingRange = includeOverdue ? { lt: range.lt } : range;
  const installmentWhere = { OR: [
    { status: 'PLANNED', dueDate: pendingRange },
    { status: 'PAID', OR: [{ dueDate: range }, { paidAt: range }] },
  ] };
  const purchases = await database.purchase.findMany({
    where: { householdId, OR: [
      { paymentMethod: 'UPFRONT', paymentDate: range },
      { paymentMethod: 'FINANCED', financing: { downPaymentPaidAt: range } },
      { paymentMethod: 'FINANCED', archivedAt: null, purchaseDate: pendingRange,
        financing: { downPaymentCents: { gt: 0 }, downPaymentPaidAt: null } },
      { paymentMethod: 'FINANCED', financing: { installments: { some: installmentWhere } } },
    ] },
    select: {
      id: true, householdId: true, merchant: true, purchaseDate: true, archivedAt: true,
      paymentMethod: true, paymentDate: true, paidAmountCents: true, paymentAllocationSnapshot: true,
      ownershipType: true, personalPersonId: true, personalPerson: { select: personSelect },
      shares: { select: { householdPersonId: true, shareBps: true, householdPerson: { select: personSelect } } },
      items: { select: { name: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1 },
      financing: { select: {
        id: true, downPaymentCents: true, downPaymentPaidAt: true, downPaymentAllocationSnapshot: true, installmentCount: true,
        installments: { where: installmentWhere, select: {
          id: true, sequence: true, dueDate: true, status: true, expectedAmountCents: true,
          actualAmountCents: true, paidAt: true, paymentAllocationSnapshot: true,
        }, orderBy: { sequence: 'asc' } },
      } },
    },
  });
  const financingIds = purchases.flatMap((purchase) => purchase.financing ? [purchase.financing.id] : []);
  // First pending is global, not merely the first row inside the requested
  // calendar month. One batched relation query avoids a request per purchase.
  const firstPending = financingIds.length && database.purchaseFinancing?.findMany
    ? await database.purchaseFinancing.findMany({
      where: { id: { in: financingIds }, purchase: { householdId } },
      select: { id: true, installments: { where: { status: 'PLANNED' }, orderBy: { sequence: 'asc' }, take: 1, select: { id: true } } },
    }) : [];
  // The historical user is the privacy boundary, not today's person linkage.
  // Use only the viewer's current aggregation key; never expose a former person
  // id now linked to somebody else, nor introduce synthetic common contributors.
  // The internal prepare-month calculation needs the same remapping, otherwise
  // its saved contribution could leak an old payer's money to the new linkage.
  const people = await database.householdPerson.findMany({
    where: { householdId, ...(actorUserId ? { linkedUserId: actorUserId } : {}), isActive: true, archivedAt: null },
    select: { id: true, linkedUserId: true },
  });
  const currentIdByUser = new Map(people.filter((person) => person.linkedUserId).map((person) => [person.linkedUserId, person.id]));
  const sources = buildPurchaseFinancialSources(purchases, { actorUserId, from, to, includeOverdue,
    personalPersonIdForAllocation: (part) => part.linkedUserId ? currentIdByUser.get(part.linkedUserId) ?? null
      : !actorUserId && people.some((person) => person.id === part.personalPersonId && !person.linkedUserId) ? part.personalPersonId : null,
    firstPendingByFinancing: new Map(firstPending.map((financing) => [financing.id, financing.installments[0]?.id ?? null])) });
  return sources.map((source) => source.scope === 'PERSONAL'
    ? { ...source, id: `${source.sourceType}:${source.installmentId ?? source.purchaseId}:PERSONAL:${actorUserId ? 'VIEWER' : source.personalPersonId ?? 'UNASSIGNED'}` }
    : source);
}

export function upcomingPurchasePayments(sources, calculationDate, { includeOverdue = false, daysAhead } = {}) {
  const date = toCivilDate(calculationDate);
  const last = daysAhead == null ? null : addCalendarDays(date, daysAhead);
  return sources.filter((source) => source.status === 'PLANNED' && source.canAccessPurchase
    && (includeOverdue || compareCivilDates(source.dueDate, date) >= 0)
    && (!last || compareCivilDates(source.dueDate, last) <= 0)).map((source) => ({
    ...source, amountCents: source.expectedAmountCents, category: null,
  }));
}
