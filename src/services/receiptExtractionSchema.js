import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

const confidence = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const cents = z.number().int().min(0).max(2_147_483_647).nullable();
const text = (max) => z.string().min(1).max(max).nullable();
const documentWarranty = z.object({
  durationMonths: z.number().int().min(1).max(1200).nullable(),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
}).strict().nullable();
const receiptItemSchema = z.object({
  name: text(200), quantity: z.number().int().min(1).max(10_000).nullable(),
  unitPriceCents: cents, totalPriceCents: cents,
  brand: text(120), model: text(120), confidence, warranty: documentWarranty,
}).strict();

// Every field is required, but unknown values are explicitly null. Strict
// objects exclude ownership and payment/financing decisions. Warranty is only
// documentary evidence, never an inferred legal/manufacturer entitlement.
export const receiptExtractionSchema = z.object({
  documentType: z.enum(['RECEIPT', 'INVOICE', 'UNKNOWN']),
  merchant: z.object({ name: text(200), confidence }).strict(),
  purchaseDate: z.object({ value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), confidence }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  subtotalCents: cents,
  taxCents: cents,
  discountCents: cents,
  totalCents: cents,
  documentNumber: text(200),
  items: z.array(receiptItemSchema).max(50),
  needsReview: z.boolean(),
  warnings: z.array(z.string().min(1).max(300)).max(20),
}).strict();

export const receiptExtractionFormat = zodTextFormat(receiptExtractionSchema, 'purchase_receipt_extraction');
export const receiptExtractionJsonSchema = receiptExtractionFormat.schema;
// Stored analyses from earlier versions lack warranty. Keep their original
// shape and nulls while requiring the field in every new provider response.
const persistedExtractionSchema = receiptExtractionSchema.extend({
  items: z.array(receiptItemSchema.extend({ warranty: documentWarranty.optional() })).max(50),
});
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));

export class ReceiptExtractionValidationError extends Error {
  constructor() {
    super('El resultado del análisis no tiene un formato válido.');
    this.name = 'ReceiptExtractionValidationError';
  }
}

function validDate(value) {
  if (value === null) return true;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 100
    && date.toISOString().slice(0, 10) === value;
}

/** Deterministic post-validation. Never invent a missing price, quantity, date,
 * currency or merchant; warnings inform review and never mutate financial data. */
export function validateReceiptExtraction(value) {
  const result = persistedExtractionSchema.safeParse(value);
  if (!result.success) throw new ReceiptExtractionValidationError();
  const data = result.data;
  if (data.items.some(({ warranty }) => warranty && (
    !validDate(warranty.endsAt) || (warranty.endsAt === null && warranty.durationMonths === null)
  ))) throw new ReceiptExtractionValidationError();
  if (!validDate(data.purchaseDate.value) || (data.currency !== null && !currencyCodes.has(data.currency))) {
    throw new ReceiptExtractionValidationError();
  }
  const strings = [data.merchant.name, data.documentNumber, ...data.items.flatMap((item) => [item.name, item.brand, item.model])];
  if (strings.some((item) => item !== null && item.trim().length === 0)) throw new ReceiptExtractionValidationError();
  const warnings = [];
  if (data.documentType === 'UNKNOWN') warnings.push('No se ha podido identificar con claridad el tipo de documento.');
  if (data.merchant.name === null) warnings.push('No se ha podido identificar el comercio.');
  if (data.purchaseDate.value === null) warnings.push('No se ha podido identificar la fecha de compra.');
  if (data.currency === null) warnings.push('No se ha podido identificar la moneda.');
  if (data.totalCents === null) warnings.push('No se ha podido identificar el total del documento.');
  if (data.items.length === 0) warnings.push('No se han podido identificar productos. Añádelos durante la revisión.');
  if (data.items.some((item) => item.name === null || item.quantity === null || item.totalPriceCents === null)) {
    warnings.push('Hay productos con datos incompletos. Revísalos antes de guardar.');
  }
  if (data.merchant.confidence !== 'HIGH' || data.purchaseDate.confidence !== 'HIGH'
    || data.items.some((item) => item.confidence !== 'HIGH')) {
    warnings.push('Hay datos detectados con incertidumbre. Compruébalos con el documento original.');
  }
  const mismatch = (left, right) => (left >= right ? left - right : right - left) > 2n;
  if (data.items.length > 0 && data.totalCents !== null && data.items.every((item) => item.totalPriceCents !== null)) {
    const sum = data.items.reduce((total, item) => total + BigInt(item.totalPriceCents), 0n);
    if (mismatch(sum, BigInt(data.totalCents))) warnings.push('Los productos detectados no coinciden con el total del documento.');
  }
  if (data.items.some((item) => item.quantity !== null && item.unitPriceCents !== null && item.totalPriceCents !== null
    && mismatch(BigInt(item.quantity) * BigInt(item.unitPriceCents), BigInt(item.totalPriceCents)))) {
    warnings.push('Hay importes de productos que no coinciden con su cantidad y precio unitario.');
  }
  if ([data.subtotalCents, data.taxCents, data.discountCents, data.totalCents].every((amount) => amount !== null)
    && mismatch(BigInt(data.subtotalCents) + BigInt(data.taxCents) - BigInt(data.discountCents), BigInt(data.totalCents))) {
    warnings.push('El subtotal, los impuestos y el descuento no coinciden con el total.');
  }
  return { ...data, needsReview: true, warnings: [...new Set([...warnings, ...data.warnings])].slice(0, 20) };
}
