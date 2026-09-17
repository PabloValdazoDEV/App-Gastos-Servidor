import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { requireHouseholdRole } from '../households/authorization.js';
import { toIsoDate } from '../../services/date.service.js';
import { assertRealPaymentDate } from './purchasePayments.js';
import { requireVisiblePurchase } from './purchases.service.js';
import { householdToday, serializePurchase } from './warranty.js';
import { Prisma } from '@prisma/client';
import { canRegisterPurchaseInstallment, createPurchaseAllocationSnapshot } from './purchaseAllocation.js';
import { retainPurchasePaymentAllocation } from './paymentAllocation.service.js';

const snapshot = (installment) => ({
  status: installment.status, actualAmountCents: installment.actualAmountCents,
  paidAt: installment.paidAt ? toIsoDate(installment.paidAt) : null, notes: installment.notes,
  paymentAllocationSnapshot: installment.paymentAllocationSnapshot ?? null,
});

export async function mutatePurchaseInstallmentPayment(prisma, context, operation, input) {
  return runSerializableTransaction(prisma, async (database) => {
    const { household } = await requireHouseholdRole(database, context);
    const purchase = await requireVisiblePurchase(database, context);
    const installment = purchase.financing?.installments.find((candidate) => candidate.id === context.installmentId);
    if (purchase.paymentMethod !== 'FINANCED' || !installment) throw createDomainError(404, 'PURCHASE_INSTALLMENT_NOT_FOUND', 'No se encontró la cuota solicitada.');
    if (operation === 'pay' && installment.status !== 'PLANNED') throw createDomainError(409, 'PURCHASE_INSTALLMENT_NOT_PLANNED', 'La cuota ya tiene un pago registrado o está anulada. Recarga la compra para comprobar su estado.');
    if (operation === 'pay' && !canRegisterPurchaseInstallment(purchase, installment)) throw createDomainError(409, 'PURCHASE_INSTALLMENT_OUT_OF_ORDER', 'Primero registra el pago de la primera cuota pendiente. Puedes pagarla por adelantado.');
    if (operation !== 'pay' && installment.status !== 'PAID') throw createDomainError(409, 'PURCHASE_INSTALLMENT_NOT_PAID', 'Esta cuota no tiene un pago registrado que corregir.');
    if (operation === 'revert' && input?.confirm !== true) throw createDomainError(400, 'PURCHASE_INSTALLMENT_REVERT_CONFIRMATION_REQUIRED', 'Confirma que quieres retirar el pago registrado.');
    const today = householdToday(household.timezone);
    if (operation !== 'revert') assertRealPaymentDate(input.paidAt, today);
    await database.purchase.update({ where: { id: purchase.id }, data: { updatedAt: new Date() } });
    const changed = await database.purchaseInstallment.update({ where: { id: installment.id }, data: operation === 'revert'
      ? { status: 'PLANNED', actualAmountCents: null, paidAt: null, notes: null, paymentAllocationSnapshot: Prisma.DbNull }
      : { status: 'PAID', actualAmountCents: input.actualAmountCents, paidAt: input.paidAt,
        paymentAllocationSnapshot: operation === 'pay' ? createPurchaseAllocationSnapshot(purchase)
          : retainPurchasePaymentAllocation(installment.paymentAllocationSnapshot),
        notes: Object.hasOwn(input, 'notes') ? input.notes : installment.notes },
    });
    await createAuditLog(database, {
      actorUserId: context.userId, householdId: context.householdId,
      action: operation === 'pay' ? 'PURCHASE_INSTALLMENT_PAID' : 'PURCHASE_INSTALLMENT_CORRECTED',
      resourceType: 'PurchaseInstallment', resourceId: installment.id,
      metadata: { purchaseId: purchase.id, purchaseFinancingId: purchase.financing.id,
        operation, before: snapshot(installment), after: snapshot(changed) },
    });
    return serializePurchase(await requireVisiblePurchase(database, context), today);
  });
}
