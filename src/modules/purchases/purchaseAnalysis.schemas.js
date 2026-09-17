import { z } from 'zod';
import { toCivilDate } from '../../services/date.service.js';
import { moneyCentsSchema, uuidSchema } from '../household-domain/commonSchemas.js';

const text = (maximum) => z.string().trim().max(maximum)
  .refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'El texto contiene caracteres no válidos.')
  .transform((value) => value || null).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  try { toCivilDate(value); return true; } catch { return false; }
}, 'Introduce una fecha válida.').nullable();
const cents = moneyCentsSchema.nullable();
const currencies = new Set(Intl.supportedValuesOf('currency'));

export const purchaseAnalysisParamsSchema = z.object({
  householdId: uuidSchema, purchaseId: uuidSchema, documentId: uuidSchema, analysisId: uuidSchema.optional(),
}).strict();
export const analyzePurchaseDocumentSchema = z.object({ consent: z.literal(true) }).strict();
export const reviewedPurchaseDocumentSchema = z.object({
  merchant: text(200), purchaseDate: date, totalCents: cents,
  currency: z.string().regex(/^[A-Z]{3}$/).refine((value) => currencies.has(value), 'Selecciona una moneda válida.').nullable(),
  items: z.array(z.object({
    name: text(200), quantity: z.number().int().min(1).max(10_000).nullable(),
    unitPriceCents: cents, totalPriceCents: cents, brand: text(120), model: text(120),
  }).strict()).max(50),
}).strict();
export const confirmPurchaseAnalysisSchema = z.object({
  purchaseVersion: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedData: reviewedPurchaseDocumentSchema,
  apply: z.object({ merchant: z.boolean(), purchaseDate: z.boolean(), total: z.boolean(), items: z.enum(['ADD', 'NONE']) }).strict(),
  acknowledgeTotalMismatch: z.boolean(),
}).strict().superRefine((input, context) => {
  if (!input.apply.merchant && !input.apply.purchaseDate && !input.apply.total && input.apply.items !== 'ADD') {
    context.addIssue({ code: 'custom', path: ['apply'], message: 'Selecciona los datos que quieres guardar.' });
  }
  if (input.apply.purchaseDate && !input.reviewedData.purchaseDate) context.addIssue({ code: 'custom', path: ['reviewedData', 'purchaseDate'], message: 'Indica la fecha revisada o no apliques ese campo.' });
  if (input.apply.total && input.reviewedData.totalCents === null) context.addIssue({ code: 'custom', path: ['reviewedData', 'totalCents'], message: 'Indica el total revisado o no apliques ese campo.' });
  if (input.apply.items === 'ADD') {
    if (!input.reviewedData.items.length) context.addIssue({ code: 'custom', path: ['reviewedData', 'items'], message: 'Añade al menos un producto revisado.' });
    input.reviewedData.items.forEach((item, index) => {
      for (const field of ['name', 'quantity']) {
        if (item[field] == null) context.addIssue({ code: 'custom', path: ['reviewedData', 'items', index, field], message: 'Completa el dato antes de añadir el producto.' });
      }
    });
  }
});

export function reviewedPurchaseTotalMismatch({ items, totalCents }) {
  return totalCents !== null && items.length > 0 && items.every((item) => item.totalPriceCents !== null)
    && items.reduce((sum, item) => sum + BigInt(item.totalPriceCents), 0n) !== BigInt(totalCents);
}
