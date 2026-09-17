import { addCalendarMonths, toCivilDate, toIsoDate } from '../../services/date.service.js';
import { createDomainError } from '../household-domain/domainError.js';
import { createPurchaseFinancingSchema, MAX_PURCHASE_INSTALLMENTS, MAX_PURCHASE_PAYMENT_CENTS } from './paymentSchemas.js';
import { canRegisterPurchaseInstallment } from './purchaseAllocation.js';

export const PAYMENT_INPUT_FIELDS = ['paymentMethod', 'paymentDate', 'paidAmountCents', 'financing', 'confirmPaymentReset'];
const error = (status, code, message) => createDomainError(status, `PURCHASE_${code}`, message);
const dateOrNull = (value) => value == null ? null : toIsoDate(value);
const has = (object, key) => Object.hasOwn(object, key);
const financingFieldNames = ['provider', 'downPaymentCents', 'downPaymentPaidAt', 'financedPrincipalCents', 'installmentCount', 'installmentAmountCents', 'firstInstallmentDate', 'financingTotalCents'];
const structuralFields = ['downPaymentCents', 'financedPrincipalCents', 'installmentCount', 'installmentAmountCents', 'firstInstallmentDate', 'financingTotalCents'];
const equal = (left, right) => (left instanceof Date || right instanceof Date)
  ? dateOrNull(left) === dateOrNull(right) : (left ?? null) === (right ?? null);

export function assertRealPaymentDate(value, today) {
  if (value && toCivilDate(value).getTime() > toCivilDate(today).getTime()) {
    throw error(400, 'PAYMENT_DATE_FUTURE', 'La fecha de un pago realizado no puede ser futura.');
  }
}

export function generatePurchaseInstallments({ installmentCount, installmentAmountCents, firstInstallmentDate, financingTotalCents }) {
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_PURCHASE_INSTALLMENTS
    || ![installmentAmountCents, financingTotalCents].every((value) => Number.isInteger(value) && value > 0 && value <= MAX_PURCHASE_PAYMENT_CENTS)) {
    throw error(400, 'FINANCING_INVALID', 'Revisa el número de cuotas y sus importes.');
  }
  const lastAmount = BigInt(financingTotalCents) - BigInt(installmentCount - 1) * BigInt(installmentAmountCents);
  if (lastAmount <= 0n || lastAmount > BigInt(MAX_PURCHASE_PAYMENT_CENTS)) {
    throw error(400, 'FINANCING_LAST_INSTALLMENT_INVALID', 'El total de cuotas debe permitir una última cuota positiva. Revisa el importe habitual y el total.');
  }
  const firstDate = toCivilDate(firstInstallmentDate);
  const lastDate = addCalendarMonths(firstDate, installmentCount - 1);
  if (lastDate.getUTCFullYear() > 9999) throw error(400, 'FINANCING_DATE_OUT_OF_RANGE', 'La última cuota debe quedar como máximo en el año 9999.');
  return Array.from({ length: installmentCount }, (_, index) => ({
    sequence: index + 1,
    // Anchor every installment to the ORIGINAL day: Jan 31 -> Feb 28 -> Mar 31.
    dueDate: addCalendarMonths(firstDate, index),
    expectedAmountCents: index === installmentCount - 1 ? Number(lastAmount) : installmentAmountCents,
    status: 'PLANNED',
  }));
}

export function calculateFinancingProgress(financing, purchaseTotalCents) {
  const installments = financing.installments ?? [];
  const paid = installments.filter((installment) => installment.status === 'PAID');
  const planned = installments.filter((installment) => installment.status === 'PLANNED');
  const downPaymentPendingCents = financing.downPaymentPaidAt ? 0 : financing.downPaymentCents;
  const paidCents = paid.reduce((sum, installment) => sum + installment.actualAmountCents, financing.downPaymentPaidAt ? financing.downPaymentCents : 0);
  const pendingCents = planned.reduce((sum, installment) => sum + installment.expectedAmountCents, downPaymentPendingCents);
  const totalCostCents = financing.downPaymentCents + financing.financingTotalCents;
  if (![paidCents, pendingCents, totalCostCents].every(Number.isSafeInteger)) throw error(400, 'PAYMENT_TOTAL_OUT_OF_RANGE', 'El total de pagos supera el rango admitido.');
  const next = [...planned].sort((left, right) => toCivilDate(left.dueDate) - toCivilDate(right.dueDate) || left.sequence - right.sequence)[0];
  return {
    paidCents, pendingCents, downPaymentPendingCents,
    paidInstallmentCount: paid.length, installmentCount: financing.installmentCount,
    nextInstallment: next ? { id: next.id, sequence: next.sequence, dueDate: toIsoDate(next.dueDate), expectedAmountCents: next.expectedAmountCents } : null,
    costOfFinancingCents: totalCostCents - purchaseTotalCents, totalCostCents,
  };
}

export function serializePurchasePayment(purchase, { list = false } = {}) {
  const financing = purchase.financing;
  const publicFinancing = financing ? { ...financing } : null;
  if (publicFinancing) delete publicFinancing.downPaymentAllocationSnapshot;
  return {
    paymentMethod: purchase.paymentMethod ?? 'UPFRONT',
    paymentDate: dateOrNull(purchase.paymentDate), paidAmountCents: purchase.paidAmountCents ?? null,
    financing: financing ? {
      ...publicFinancing,
      firstInstallmentDate: toIsoDate(financing.firstInstallmentDate), downPaymentPaidAt: dateOrNull(financing.downPaymentPaidAt),
      installments: list ? undefined : financing.installments.map((installment) => {
        const publicInstallment = { ...installment };
        delete publicInstallment.paymentAllocationSnapshot;
        return {
          ...publicInstallment, dueDate: toIsoDate(installment.dueDate), paidAt: dateOrNull(installment.paidAt),
          canRegisterPayment: canRegisterPurchaseInstallment(purchase, installment),
          canEditPayment: !purchase.archivedAt && installment.status === 'PAID',
        };
      }),
      progress: calculateFinancingProgress(financing, purchase.totalCents),
    } : null,
  };
}

export function paymentSnapshot(purchase) {
  const financing = purchase?.financing;
  return purchase ? {
    paymentMethod: purchase.paymentMethod ?? 'UPFRONT',
    paymentDate: dateOrNull(purchase.paymentDate), paidAmountCents: purchase.paidAmountCents ?? null,
    financing: financing ? Object.fromEntries(financingFieldNames.map((key) => [key,
      ['downPaymentPaidAt', 'firstInstallmentDate'].includes(key) ? dateOrNull(financing[key]) : financing[key] ?? null,
    ])) : null,
  } : null;
}

// Pure preparation runs before any destructive write. Payment evidence is
// optional and explicit: legacy/default UPFRONT never invents a date or amount.
export function preparePurchasePayment(input, existing, today) {
  const previousMethod = existing?.paymentMethod ?? 'UPFRONT';
  const paymentMethod = input.paymentMethod ?? previousMethod;
  const methodChanged = existing != null && previousMethod !== paymentMethod;
  const oldFinancing = existing?.financing ?? null;
  const hasPaidInstallments = oldFinancing?.installments?.some((installment) => installment.status === 'PAID') ?? false;
  const totalCents = input.totalCents ?? existing?.totalCents;
  const resetConfirmed = input.confirmPaymentReset === true;
  if (methodChanged && hasPaidInstallments) {
    throw error(409, 'FINANCING_PAID_INSTALLMENTS', 'Ya existen cuotas registradas como pagadas. No se puede cambiar la forma de pago ni regenerar la financiación.');
  }
  if (hasPaidInstallments && ((has(input, 'totalCents') && input.totalCents !== existing.totalCents)
    || structuralFields.some((field) => has(input.financing ?? {}, field) && !equal(input.financing[field], oldFinancing[field])))) {
    throw error(409, 'FINANCING_PAID_INSTALLMENTS', 'Ya existen cuotas registradas como pagadas. Solo puedes editar datos no estructurales, como la entidad.');
  }
  const removesRecordedPayment = methodChanged && (existing?.paymentDate || oldFinancing?.downPaymentPaidAt);
  if (removesRecordedPayment && !resetConfirmed) {
    throw error(409, 'PAYMENT_RESET_CONFIRMATION_REQUIRED', 'Esta compra tiene un pago registrado. Confirma expresamente el cambio de forma de pago para conservar su corrección en el historial.');
  }
  let purchaseFields;
  let financingFields = null;
  let installments = null;
  let structureChanged = false;
  if (paymentMethod === 'UPFRONT') {
    if (input.financing != null) throw error(400, 'FINANCING_NOT_ALLOWED', 'Una compra al contado no puede incluir financiación.');
    const paymentDate = has(input, 'paymentDate') ? input.paymentDate : previousMethod === 'UPFRONT' ? existing?.paymentDate ?? null : null;
    const paidAmountCents = has(input, 'paidAmountCents') ? input.paidAmountCents : previousMethod === 'UPFRONT' ? existing?.paidAmountCents ?? null : null;
    if ((paymentDate == null) !== (paidAmountCents == null)) throw error(400, 'UPFRONT_PAYMENT_INCOMPLETE', 'Indica fecha e importe del pago, o deja ambos sin confirmar.');
    if (existing?.paymentDate && paymentDate == null && !resetConfirmed) throw error(409, 'PAYMENT_RESET_CONFIRMATION_REQUIRED', 'Confirma que quieres retirar el pago registrado. La corrección quedará en el historial.');
    assertRealPaymentDate(paymentDate, today);
    purchaseFields = { paymentMethod, paymentDate, paidAmountCents };
  } else {
    if (input.paymentDate != null || input.paidAmountCents != null) throw error(400, 'UPFRONT_PAYMENT_NOT_ALLOWED', 'Registra la entrada y las cuotas dentro de la financiación.');
    if (has(input, 'financing') && input.financing === null) throw error(400, 'FINANCING_REQUIRED', 'Completa los datos de financiación.');
    const previousFields = oldFinancing ? Object.fromEntries(financingFieldNames.filter((field) => field !== 'financedPrincipalCents').map((field) => [field, oldFinancing[field]])) : {};
    const merged = { provider: null, downPaymentCents: 0, downPaymentPaidAt: null, ...previousFields, ...input.financing };
    const entryAmountChanged = oldFinancing && merged.downPaymentCents !== oldFinancing.downPaymentCents;
    if (oldFinancing?.downPaymentPaidAt && (merged.downPaymentPaidAt == null || entryAmountChanged) && !resetConfirmed) {
      throw error(409, 'PAYMENT_RESET_CONFIRMATION_REQUIRED', 'Confirma la corrección de la entrada pagada para conservar el registro anterior en el historial.');
    }
    if (entryAmountChanged && oldFinancing.downPaymentPaidAt && !has(input.financing ?? {}, 'downPaymentPaidAt')) merged.downPaymentPaidAt = null;
    financingFields = createPurchaseFinancingSchema.parse({
      ...merged,
      firstInstallmentDate: merged.firstInstallmentDate == null ? undefined : toIsoDate(merged.firstInstallmentDate),
      downPaymentPaidAt: dateOrNull(merged.downPaymentPaidAt),
    });
    if (financingFields.downPaymentCents > totalCents) throw error(400, 'FINANCING_DOWN_PAYMENT_INVALID', 'La entrada no puede superar el precio de compra.');
    financingFields.financedPrincipalCents = totalCents - financingFields.downPaymentCents;
    if (financingFields.financingTotalCents < financingFields.financedPrincipalCents) throw error(400, 'FINANCING_TOTAL_INVALID', 'El total a pagar en cuotas no puede ser menor que el principal financiado.');
    if (financingFields.downPaymentPaidAt && financingFields.downPaymentCents === 0) throw error(400, 'FINANCING_DOWN_PAYMENT_INVALID', 'No hay entrada que registrar como pagada.');
    assertRealPaymentDate(financingFields.downPaymentPaidAt, today);
    structureChanged = !oldFinancing || structuralFields.some((field) => !equal(oldFinancing[field], financingFields[field]))
      || (existing && existing.totalCents !== totalCents);
    if (hasPaidInstallments && structureChanged) throw error(409, 'FINANCING_PAID_INSTALLMENTS', 'Ya existen cuotas registradas como pagadas. Solo puedes editar datos no estructurales, como la entidad.');
    installments = generatePurchaseInstallments(financingFields);
    purchaseFields = { paymentMethod, paymentDate: null, paidAmountCents: null };
  }
  const before = paymentSnapshot(existing);
  const after = paymentSnapshot({ ...purchaseFields, financing: financingFields });
  return {
    purchaseFields, financingFields, installments, structureChanged, methodChanged, before, after,
    paymentChanged: JSON.stringify(before) !== JSON.stringify(after),
    financingChanged: JSON.stringify(before?.financing ?? null) !== JSON.stringify(after.financing),
    resetConfirmed,
  };
}
