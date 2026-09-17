import { describe, expect, it } from 'vitest';
import { toIsoDate } from '../src/services/date.service.js';
import { assertRealPaymentDate, calculateFinancingProgress, generatePurchaseInstallments, preparePurchasePayment, serializePurchasePayment } from '../src/modules/purchases/purchasePayments.js';
import { createPurchaseFinancingSchema, installmentPaymentSchema, MAX_PURCHASE_INSTALLMENTS, MAX_PURCHASE_PAYMENT_CENTS, revertInstallmentPaymentSchema, updatePurchaseFinancingSchema } from '../src/modules/purchases/paymentSchemas.js';
import { financingInput } from './helpers/purchasePaymentsFixtures.js';

const today = '2026-09-17';
const day = (value) => new Date(`${value}T00:00:00Z`);
const plan = (changes = {}) => generatePurchaseInstallments({ ...financingInput, ...changes });
function financing(changes = {}) {
  return {
    id: 'financing', ...createPurchaseFinancingSchema.parse(financingInput),
    financedPrincipalCents: 100_000,
    installments: plan().map((row) => ({ ...row, id: `installment-${row.sequence}`, actualAmountCents: null, paidAt: null })),
    ...changes,
  };
}
const purchase = (changes = {}) => ({ id: 'purchase', totalCents: 120_000, paymentMethod: 'FINANCED', paymentDate: null, paidAmountCents: null, financing: financing(), ...changes });

describe('purchase installment calendar and integer money', () => {
  it.each([
    ['2026-10-15', ['2026-10-15', '2026-11-15', '2026-12-15']],
    ['2026-12-31', ['2026-12-31', '2027-01-31', '2027-02-28']],
    ['2026-01-31', ['2026-01-31', '2026-02-28', '2026-03-31']],
    ['2024-01-31', ['2024-01-31', '2024-02-29', '2024-03-31']],
    ['2024-02-29', ['2024-02-29', '2024-03-29', '2024-04-29']],
    ['2026-08-30', ['2026-08-30', '2026-09-30', '2026-10-30']],
  ])('anchors every installment to the original civil day %s', (firstInstallmentDate, expected) => {
    const installments = plan({ installmentCount: 3, installmentAmountCents: 3333, financingTotalCents: 10_000, firstInstallmentDate });
    expect(installments.map((row) => toIsoDate(row.dueDate))).toEqual(expected);
    expect(installments.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(installments.every((row) => row.status === 'PLANNED')).toBe(true);
  });
  it.each([
    [3, 3333, 10_000, [3333, 3333, 3334]],
    [3, 3334, 10_000, [3334, 3334, 3332]],
    [1, 1234, 10_000, [10_000]],
    [4, 1, 5, [1, 1, 1, 2]],
    [2, 1, MAX_PURCHASE_PAYMENT_CENTS, [1, MAX_PURCHASE_PAYMENT_CENTS - 1]],
  ])('preserves every cent for %i installments of %i, total %i', (installmentCount, installmentAmountCents, financingTotalCents, expected) => {
    const amounts = plan({ installmentCount, installmentAmountCents, financingTotalCents }).map((row) => row.expectedAmountCents);
    expect(amounts).toEqual(expected);
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(financingTotalCents);
    expect(amounts.every(Number.isSafeInteger)).toBe(true);
  });
  it.each([
    { installmentCount: 0 }, { installmentCount: -1 }, { installmentCount: 1.5 }, { installmentCount: MAX_PURCHASE_INSTALLMENTS + 1 },
    { installmentAmountCents: 0 }, { installmentAmountCents: -1 }, { installmentAmountCents: 1.2 },
    { financingTotalCents: 0 }, { financingTotalCents: -1 }, { financingTotalCents: MAX_PURCHASE_PAYMENT_CENTS + 1 },
    { installmentCount: 3, installmentAmountCents: 5000, financingTotalCents: 10_000 },
    { installmentCount: 3, installmentAmountCents: 6000, financingTotalCents: 10_000 },
  ])('rejects invalid or non-positive final installment %j', (input) => expect(() => plan(input)).toThrow());
  it('rejects a schedule past year 9999 instead of producing a malformed ISO date', () => expect(() => plan({ firstInstallmentDate: '9999-12-31', installmentCount: 2 })).toThrow('año 9999'));
  it('supports the documented maximum count without drifting or losing cents', () => {
    const result = plan({ firstInstallmentDate: '2000-01-31', installmentCount: MAX_PURCHASE_INSTALLMENTS, installmentAmountCents: 1, financingTotalCents: MAX_PURCHASE_INSTALLMENTS + 1 });
    expect(result).toHaveLength(MAX_PURCHASE_INSTALLMENTS);
    expect(result.at(-1).expectedAmountCents).toBe(2);
    expect(result.reduce((sum, row) => sum + row.expectedAmountCents, 0)).toBe(MAX_PURCHASE_INSTALLMENTS + 1);
  });
});

describe('purchase payment schema contracts', () => {
  it('validates optional provider, deposit evidence and default zero entry', () => {
    const { downPaymentCents: removed, ...withoutEntry } = financingInput;
    expect(removed).toBe(20_000);
    expect(createPurchaseFinancingSchema.parse({ ...withoutEntry, provider: '  Tienda  ' })).toMatchObject({ provider: 'Tienda', downPaymentCents: 0, downPaymentPaidAt: null });
  });
  it('metadata PATCH never supplies structural defaults', () => expect(updatePurchaseFinancingSchema.parse({ provider: ' Nuevo ' })).toEqual({ provider: 'Nuevo' }));
  it.each([
    { financedPrincipalCents: 1 }, { interestRate: 10 }, { installments: [] }, { provider: 'x'.repeat(201) },
    { firstInstallmentDate: '2026-02-30' }, { firstInstallmentDate: '2026-10-15T00:00:00Z' },
  ])('rejects supplied derived fields, unsupported scope or invalid metadata %j', (input) => expect(createPurchaseFinancingSchema.safeParse({ ...financingInput, ...input }).success).toBe(false));
  it.each([
    {}, { actualAmountCents: 5500 }, { paidAt: today }, { actualAmountCents: 0, paidAt: today },
    { actualAmountCents: -1, paidAt: today }, { actualAmountCents: 1.5, paidAt: today },
    { actualAmountCents: 5500, paidAt: '2026-02-30' },
    { actualAmountCents: 5500, paidAt: today, status: 'SKIPPED' },
    { actualAmountCents: 5500, paidAt: today, status: 'CANCELLED' },
  ])('requires real positive amount and civil date, disallows generic status mutation %j', (input) => expect(installmentPaymentSchema.safeParse(input).success).toBe(false));
  it('trims payment notes and never infers a payment date', () => expect(installmentPaymentSchema.parse({ actualAmountCents: 5500, paidAt: today, notes: ' Anticipado ' })).toEqual({ actualAmountCents: 5500, paidAt: day(today), notes: 'Anticipado' }));
  it.each([{}, { confirm: false }, { confirm: 'true' }, { confirm: true, status: 'PLANNED' }])('requires explicit reversal confirmation only %j', (input) => expect(revertInstallmentPaymentSchema.safeParse(input).success).toBe(false));
  it('accepts true reversal confirmation', () => expect(revertInstallmentPaymentSchema.parse({ confirm: true })).toEqual({ confirm: true }));
});

describe('financing progress is isolated from household finances', () => {
  it('does not mark an unconfirmed deposit paid and excludes it from installment count', () => {
    expect(calculateFinancingProgress(financing(), 120_000)).toMatchObject({
      paidCents: 0, pendingCents: 130_000, downPaymentPendingCents: 20_000,
      paidInstallmentCount: 0, installmentCount: 20, costOfFinancingCents: 10_000, totalCostCents: 130_000,
      nextInstallment: { sequence: 1, dueDate: '2026-10-15', expectedAmountCents: 5500 },
    });
  });
  it('sums actual PAID money, planned expected amounts and confirmed deposit independently', () => {
    const state = financing({ downPaymentPaidAt: day(today) });
    state.installments[0] = { ...state.installments[0], status: 'PAID', actualAmountCents: 5400, paidAt: day(today) };
    state.installments[1] = { ...state.installments[1], status: 'CANCELLED' };
    expect(calculateFinancingProgress(state, 120_000)).toMatchObject({ paidCents: 25_400, pendingCents: 99_000, paidInstallmentCount: 1, installmentCount: 20, downPaymentPendingCents: 0, nextInstallment: { sequence: 3 } });
  });
  it('chooses next planned installment by due date, not array order or payment date', () => {
    const state = financing();
    state.installments.reverse();
    const progress = calculateFinancingProgress(state, 120_000);
    expect(progress.nextInstallment.sequence).toBe(1);
    expect(state.installments[0].sequence).toBe(20);
  });
  it('completed financing has no next installment and no pending balance', () => {
    const state = financing({ downPaymentPaidAt: day(today) });
    state.installments = state.installments.map((row) => ({ ...row, status: 'PAID', actualAmountCents: row.expectedAmountCents, paidAt: day(today) }));
    expect(calculateFinancingProgress(state, 120_000)).toMatchObject({ paidCents: 130_000, pendingCents: 0, paidInstallmentCount: 20, nextInstallment: null });
  });
  it('uses safe derived sums beyond a single PostgreSQL integer field', () => {
    const state = financing({ downPaymentCents: MAX_PURCHASE_PAYMENT_CENTS, downPaymentPaidAt: day(today), financingTotalCents: MAX_PURCHASE_PAYMENT_CENTS, installmentCount: 1, installments: [{ id: 'one', sequence: 1, dueDate: day(today), expectedAmountCents: MAX_PURCHASE_PAYMENT_CENTS, actualAmountCents: MAX_PURCHASE_PAYMENT_CENTS, status: 'PAID' }] });
    expect(calculateFinancingProgress(state, MAX_PURCHASE_PAYMENT_CENTS)).toMatchObject({ paidCents: 4294967294, totalCostCents: 4294967294, costOfFinancingCents: MAX_PURCHASE_PAYMENT_CENTS });
  });
  it('serializes civil dates and omits full installment history from list summaries', () => {
    const source = purchase();
    const detail = serializePurchasePayment(source);
    expect(detail.financing.firstInstallmentDate).toBe('2026-10-15');
    expect(detail.financing.installments[0].dueDate).toBe('2026-10-15');
    const list = serializePurchasePayment(source, { list: true });
    expect(list.financing.installments).toBeUndefined();
    expect(list.financing.progress.installmentCount).toBe(20);
  });
});

describe('payment model preparation protects actual history', () => {
  it('keeps legacy upfront money unconfirmed and derives financed principal', () => {
    expect(preparePurchasePayment({ totalCents: 120_000 }, null, today).purchaseFields).toEqual({ paymentMethod: 'UPFRONT', paymentDate: null, paidAmountCents: null });
    const result = preparePurchasePayment({ totalCents: 120_000, paymentMethod: 'FINANCED', financing: financingInput }, null, today);
    expect(result.financingFields).toMatchObject({ financedPrincipalCents: 100_000, downPaymentPaidAt: null });
  });
  it.each([
    { downPaymentCents: 120_001 }, { financingTotalCents: 99_999 },
    { downPaymentCents: 0, downPaymentPaidAt: today },
  ])('rejects invalid purchase-dependent financing %j', (input) => expect(() => preparePurchasePayment({ totalCents: 120_000, paymentMethod: 'FINANCED', financing: { ...financingInput, ...input } }, null, today)).toThrow());
  it('rejects future evidence but allows anticipation relative to the installment due date', () => {
    expect(() => assertRealPaymentDate('2026-09-18', today)).toThrow('futura');
    expect(() => assertRealPaymentDate('2026-09-16', today)).not.toThrow();
    expect(() => assertRealPaymentDate(today, today)).not.toThrow();
  });
  it.each([{ paymentDate: today }, { paidAmountCents: 120_000 }])('rejects incomplete upfront evidence %j', (input) => expect(() => preparePurchasePayment({ totalCents: 120_000, paymentMethod: 'UPFRONT', ...input }, null, today)).toThrow('fecha e importe'));
  it('requires confirmation when resetting explicit upfront evidence', () => {
    const state = purchase({ paymentMethod: 'UPFRONT', paymentDate: day(today), paidAmountCents: 120_000, financing: null });
    expect(() => preparePurchasePayment({ paymentDate: null, paidAmountCents: null }, state, today)).toThrow('Confirma');
    const reset = preparePurchasePayment({ paymentDate: null, paidAmountCents: null, confirmPaymentReset: true }, state, today);
    expect(reset.before).toMatchObject({ paymentDate: today, paidAmountCents: 120_000 });
    expect(reset.after).toMatchObject({ paymentDate: null, paidAmountCents: null });
  });
  it('requires deposit correction confirmation and never silently keeps an old paid date on a changed entry', () => {
    const state = purchase({ financing: financing({ downPaymentPaidAt: day(today) }) });
    expect(() => preparePurchasePayment({ financing: { downPaymentCents: 21_000 } }, state, today)).toThrow('Confirma');
    const result = preparePurchasePayment({ financing: { downPaymentCents: 21_000 }, confirmPaymentReset: true }, state, today);
    expect(result.financingFields).toMatchObject({ downPaymentCents: 21_000, downPaymentPaidAt: null });
    expect(result.before.financing.downPaymentCents).toBe(20_000);
    expect(result.after.financing.downPaymentCents).toBe(21_000);
  });
  it('same financing values preserve structure even when all fields are resent by a form', () => {
    const state = purchase();
    const result = preparePurchasePayment({ paymentMethod: 'FINANCED', financing: financingInput }, state, today);
    expect(result.structureChanged).toBe(false);
    expect(result.financingChanged).toBe(false);
  });
  it('blocks method and structure changes with paid installments but allows provider metadata', () => {
    const state = purchase();
    state.financing.installments[0] = { ...state.financing.installments[0], status: 'PAID', actualAmountCents: 5500, paidAt: day(today) };
    expect(() => preparePurchasePayment({ paymentMethod: 'UPFRONT', confirmPaymentReset: true }, state, today)).toThrow('cuotas registradas como pagadas');
    expect(() => preparePurchasePayment({ financing: { installmentCount: 21 } }, state, today)).toThrow('cuotas registradas como pagadas');
    expect(() => preparePurchasePayment({ totalCents: 121_000 }, state, today)).toThrow('cuotas registradas como pagadas');
    expect(preparePurchasePayment({ financing: { provider: 'Nueva etiqueta' } }, state, today)).toMatchObject({ structureChanged: false, financingChanged: true });
  });
});
