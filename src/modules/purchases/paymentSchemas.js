import { z } from 'zod';
import { toCivilDate } from '../../services/date.service.js';
import { moneyCentsSchema } from '../household-domain/commonSchemas.js';

export const MAX_PURCHASE_INSTALLMENTS = 1200;
export const MAX_PURCHASE_PAYMENT_CENTS = 2147483647;
export const paymentCivilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa una fecha con formato AAAA-MM-DD.')
  .transform((value, context) => {
    try { return toCivilDate(value); } catch {
      context.addIssue({ code: 'custom', message: 'Introduce una fecha válida.' });
      return z.NEVER;
    }
  });
const text = (maximum) => z.string().trim().max(maximum)
  .refine((value) => ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
  }), 'El texto contiene caracteres no válidos.')
  .transform((value) => value || null).nullable().optional();
const positiveMoney = z.number().int().min(1, 'El importe debe ser mayor que cero.').max(MAX_PURCHASE_PAYMENT_CENTS);
const financingFields = {
  provider: text(200),
  downPaymentCents: moneyCentsSchema,
  downPaymentPaidAt: paymentCivilDateSchema.nullable().optional(),
  installmentCount: z.number().int().min(1).max(MAX_PURCHASE_INSTALLMENTS),
  installmentAmountCents: positiveMoney,
  firstInstallmentDate: paymentCivilDateSchema,
  financingTotalCents: positiveMoney,
};
export const createPurchaseFinancingSchema = z.object({ ...financingFields, downPaymentCents: financingFields.downPaymentCents.default(0) }).strict();
export const updatePurchaseFinancingSchema = z.object(financingFields).partial().strict();
export const purchasePaymentFields = {
  paymentMethod: z.enum(['UPFRONT', 'FINANCED']).optional(),
  paymentDate: paymentCivilDateSchema.nullable().optional(),
  paidAmountCents: moneyCentsSchema.nullable().optional(),
  financing: updatePurchaseFinancingSchema.nullable().optional(),
  confirmPaymentReset: z.literal(true).optional(),
};
export const installmentPaymentSchema = z.object({
  actualAmountCents: positiveMoney,
  paidAt: paymentCivilDateSchema,
  notes: text(2000),
}).strict();
export const revertInstallmentPaymentSchema = z.object({ confirm: z.literal(true) }).strict();
