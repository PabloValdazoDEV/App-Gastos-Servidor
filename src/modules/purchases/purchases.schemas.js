import { z } from 'zod';
import { toCivilDate } from '../../services/date.service.js';
import { moneyCentsSchema, uuidSchema } from '../household-domain/commonSchemas.js';
import { purchasePaymentFields } from './paymentSchemas.js';

const hasControlCharacter = (value, allowWhitespace = false) => [...value].some((character) => {
  const code = character.charCodeAt(0);
  return code === 127 || (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code)));
});
const optionalText = (limit) => z.string().trim().max(limit)
  .refine((value) => !hasControlCharacter(value, true), 'El texto contiene caracteres no válidos.')
  .transform((value) => value || null).nullable().optional();
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa una fecha con formato AAAA-MM-DD.')
  .transform((value, context) => {
    try { return toCivilDate(value); } catch {
      context.addIssue({ code: 'custom', message: 'Introduce una fecha válida.' });
      return z.NEVER;
    }
  });
const itemFields = {
  name: z.string().trim().min(1, 'Escribe el nombre del producto.').max(200)
    .refine((value) => !hasControlCharacter(value), 'El nombre contiene caracteres no válidos.'),
  brand: optionalText(120),
  model: optionalText(120),
  quantity: z.number().int().min(1).max(10_000).default(1),
  priceCents: moneyCentsSchema.nullable().optional(),
  serialNumber: optionalText(100),
  imei: optionalText(100),
  warrantyDurationMonths: z.number().int().min(1).max(1200).nullable().optional(),
  warrantyEndsAt: civilDate.nullable().optional(),
  notes: optionalText(2000),
};
export const createPurchaseItemSchema = z.object(itemFields).strict();
export const updatePurchaseItemSchema = z.object({ ...itemFields, quantity: itemFields.quantity.removeDefault() }).strict().partial()
  .refine((value) => Object.keys(value).length > 0, 'Indica algún cambio.');
export const purchaseShareSchema = z.object({
  householdPersonId: uuidSchema,
  shareBps: z.number().int().min(1).max(10_000),
}).strict();

export function validatePurchaseOwnership(value, context) {
  if (value.ownershipType === 'PERSONAL' && !value.personalPersonId) {
    context.addIssue({ code: 'custom', path: ['personalPersonId'], message: 'Selecciona la persona propietaria.' });
  }
  if (value.ownershipType === 'SPLIT') {
    const shares = value.shares ?? [];
    if (shares.length < 2) context.addIssue({ code: 'custom', path: ['shares'], message: 'Reparte la compra entre al menos dos personas.' });
    if (shares.reduce((sum, share) => sum + share.shareBps, 0) !== 10_000) {
      context.addIssue({ code: 'custom', path: ['shares'], message: 'Los porcentajes deben sumar exactamente el 100 %.' });
    }
    if (new Set(shares.map((share) => share.householdPersonId)).size !== shares.length) {
      context.addIssue({ code: 'custom', path: ['shares'], message: 'Cada persona solo puede aparecer una vez.' });
    }
  }
}

const purchaseFields = {
  ...purchasePaymentFields,
  merchant: optionalText(200),
  purchaseDate: civilDate,
  totalCents: moneyCentsSchema,
  ownershipType: z.enum(['HOUSEHOLD', 'PERSONAL', 'SPLIT']).default('HOUSEHOLD'),
  personalPersonId: uuidSchema.nullable().optional(),
  shares: z.array(purchaseShareSchema).max(100).optional(),
  notes: optionalText(2000),
};
export const ownershipSchema = z.object({
  ownershipType: purchaseFields.ownershipType,
  personalPersonId: purchaseFields.personalPersonId,
  shares: purchaseFields.shares,
}).superRefine(validatePurchaseOwnership);
export const createPurchaseSchema = z.object({
  ...purchaseFields,
  items: z.array(createPurchaseItemSchema).min(1, 'Añade al menos un producto.').max(50),
}).strict().superRefine(validatePurchaseOwnership);
export const updatePurchaseSchema = z.object({ ...purchaseFields, ownershipType: purchaseFields.ownershipType.removeDefault() }).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'Indica algún cambio.');
export const purchaseParamsSchema = z.object({
  householdId: uuidSchema,
  purchaseId: uuidSchema.optional(),
  itemId: uuidSchema.optional(),
  installmentId: uuidSchema.optional(),
}).strict();
