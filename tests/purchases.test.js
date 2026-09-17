import { describe, expect, it, vi } from 'vitest';
import { createPurchaseItemSchema, createPurchaseSchema, updatePurchaseItemSchema, updatePurchaseSchema } from '../src/modules/purchases/purchases.schemas.js';
import { canViewPurchase, normalizeOwnership, visiblePurchaseWhere } from '../src/modules/purchases/purchases.service.js';
import { householdToday, serializePurchase, warrantyFields, warrantyState, WARRANTY_EXPIRING_SOON_DAYS } from '../src/modules/purchases/warranty.js';
import { toIsoDate } from '../src/services/date.service.js';

const person = '00000000-0000-4000-8000-000000000001';
const person2 = '00000000-0000-4000-8000-000000000002';
const date = '2026-09-17';
const base = { purchaseDate: date, totalCents: 99_900, items: [{ name: 'iPhone 17' }] };
const shares = [{ householdPersonId: person, shareBps: 6000 }, { householdPersonId: person2, shareBps: 4000 }];

describe('purchase validation', () => {
  it('creates household purchase with a product and integer cents, defaults quantity', () => {
    expect(createPurchaseSchema.parse(base)).toMatchObject({ ownershipType: 'HOUSEHOLD', totalCents: 99_900, items: [{ quantity: 1 }] });
  });
  it('creates personal purchase', () => expect(createPurchaseSchema.parse({ ...base, ownershipType: 'PERSONAL', personalPersonId: person }).personalPersonId).toBe(person));
  it('rejects PERSONAL without person', () => expect(createPurchaseSchema.safeParse({ ...base, ownershipType: 'PERSONAL' }).success).toBe(false));
  it('creates 60/40 SPLIT', () => expect(createPurchaseSchema.parse({ ...base, ownershipType: 'SPLIT', shares }).shares).toEqual(shares));
  it.each([
    ['missing products', { items: [] }], ['missing items', { items: undefined }],
    ['negative total', { totalCents: -1 }], ['fractional cents', { totalCents: 100.5 }], ['int overflow', { totalCents: 2147483648 }],
    ['invalid civil date', { purchaseDate: '2026-02-30' }], ['datetime not date', { purchaseDate: '2026-09-17T00:00:00Z' }],
    ['empty product', { items: [{ name: ' ' }] }], ['no quantity', { items: [{ name: 'Phone', quantity: 0 }] }],
    ['fractional quantity', { items: [{ name: 'Phone', quantity: 1.5 }] }], ['negative item price', { items: [{ name: 'Phone', priceCents: -1 }] }],
    ['too many products', { items: Array.from({ length: 51 }, () => ({ name: 'Phone' })) }],
    ['split total !=100%', { ownershipType: 'SPLIT', shares: shares.map((share) => ({ ...share, shareBps: 4000 })) }],
    ['duplicate participant', { ownershipType: 'SPLIT', shares: shares.map((share) => ({ ...share, householdPersonId: person })) }],
    ['one participant', { ownershipType: 'SPLIT', shares: [{ householdPersonId: person, shareBps: 10000 }] }],
    ['zero share', { ownershipType: 'SPLIT', shares: [{ householdPersonId: person, shareBps: 0 }, { householdPersonId: person2, shareBps: 10000 }] }],
    ['negative share', { ownershipType: 'SPLIT', shares: [{ householdPersonId: person, shareBps: -100 }, { householdPersonId: person2, shareBps: 10100 }] }],
    ['unknown financial field', { amountCents: 99900 }],
  ])('rejects %s', (_name, input) => expect(createPurchaseSchema.safeParse({ ...base, ...input }).success).toBe(false));
  it('does not require product prices to sum to total', () => expect(createPurchaseSchema.safeParse({ ...base, items: [{ name: 'Phone', priceCents: 1 }] }).success).toBe(true));
  it('trims optional identifiers without imposing IMEI formats', () => {
    expect(createPurchaseItemSchema.parse({ name: ' Phone ', serialNumber: ' ABC123 ', imei: ' device-123 ', brand: ' ' })).toMatchObject({ name: 'Phone', serialNumber: 'ABC123', imei: 'device-123', brand: null });
  });
  it.each(['serialNumber', 'imei'])('rejects excessive %s and control characters', (field) => {
    expect(createPurchaseItemSchema.safeParse({ name: 'Phone', [field]: 'a'.repeat(101) }).success).toBe(false);
    expect(createPurchaseItemSchema.safeParse({ name: 'Phone', [field]: 'abc\u0000' }).success).toBe(false);
  });
  it.each([0, -1, 1.5, 1201])('rejects warranty duration %s', (warrantyDurationMonths) => expect(createPurchaseItemSchema.safeParse({ name: 'Phone', warrantyDurationMonths }).success).toBe(false));
  it('PATCH metadata does not default ownership or quantity', () => {
    expect(updatePurchaseSchema.parse({ merchant: ' Apple ' })).toEqual({ merchant: 'Apple' });
    expect(updatePurchaseItemSchema.parse({ brand: 'Apple' })).toEqual({ brand: 'Apple' });
  });
  it('PATCH purchase cannot replace items and empty patches fail', () => {
    expect(updatePurchaseSchema.safeParse({ items: base.items }).success).toBe(false);
    expect(updatePurchaseSchema.safeParse({}).success).toBe(false);
    expect(updatePurchaseItemSchema.safeParse({}).success).toBe(false);
  });
});

describe('calendar-based registered warranty', () => {
  it.each([
    ['2026-09-17', 36, '2029-09-17'], ['2026-01-31', 1, '2026-02-28'],
    ['2024-01-31', 1, '2024-02-29'], ['2024-02-29', 12, '2025-02-28'],
    ['2026-12-31', 2, '2027-02-28'],
  ])('%s plus %s calendar months is %s', (purchaseDate, months, expected) => {
    const result = warrantyFields({ warrantyDurationMonths: months }, purchaseDate);
    expect(result).toMatchObject({ warrantySource: 'DURATION', warrantyDurationMonths: months });
    expect(toIsoDate(result.warrantyEndsAt)).toBe(expected);
  });
  it('explicit date wins when both fields are provided', () => {
    const result = warrantyFields({ warrantyEndsAt: '2028-01-01', warrantyDurationMonths: 36 }, date);
    expect(result).toMatchObject({ warrantySource: 'EXPLICIT_DATE', warrantyDurationMonths: null });
    expect(toIsoDate(result.warrantyEndsAt)).toBe('2028-01-01');
  });
  it('does not infer any legal warranty', () => expect(warrantyFields({}, date)).toEqual({ warrantySource: null, warrantyDurationMonths: null, warrantyEndsAt: null }));
  it('rejects a calculated date beyond the civil four-digit range', () => expect(() => warrantyFields({ warrantyDurationMonths: 1200 }, '9999-12-31')).toThrow('año 9999'));
  it.each([
    [null, 'NONE', null], ['2026-11-17', 'ACTIVE', 61], ['2026-11-16', 'EXPIRING_SOON', 60],
    ['2026-09-18', 'EXPIRING_SOON', 1], ['2026-09-17', 'EXPIRING_SOON', 0], ['2026-09-16', 'EXPIRED', -1],
  ])('derives %s as %s (%s days)', (end, status, days) => expect(warrantyState(end, date)).toEqual({ warrantyStatus: status, warrantyDaysRemaining: days }));
  it('centralizes sixty days and uses household timezone for today', () => {
    expect(WARRANTY_EXPIRING_SOON_DAYS).toBe(60);
    const now = new Date('2026-09-17T23:30:00Z');
    expect(toIsoDate(householdToday('Europe/Madrid', now))).toBe('2026-09-18');
    expect(toIsoDate(householdToday('America/Los_Angeles', now))).toBe('2026-09-17');
  });
});

describe('purchase privacy and normalization', () => {
  const database = { householdPerson: { findMany: vi.fn(async ({ where }) => where.id.in.map((id) => ({ id }))) } };
  it.each(['HOUSEHOLD', 'PERSONAL', 'SPLIT'])('normalizes target %s from incompatible old fields', async (ownershipType) => {
    const result = await normalizeOwnership(database, 'household', { ownershipType, personalPersonId: person, shares });
    expect(result).toEqual({ ownershipType, personalPersonId: ownershipType === 'PERSONAL' ? person : null, shares: ownershipType === 'SPLIT' ? shares : [] });
  });
  it('keeps a split during metadata-only PATCH and strips nested relation fields', async () => {
    const existing = { ownershipType: 'SPLIT', personalPersonId: null, shares: shares.map((share) => ({ ...share, id: 'id', purchaseId: 'purchase', householdPerson: { id: share.householdPersonId } })) };
    expect(await normalizeOwnership(database, 'household', { merchant: 'Shop' }, existing)).toEqual({ ownershipType: 'SPLIT', personalPersonId: null, shares });
  });
  it('validates only changed ownership so historical archived people can be retained', async () => {
    const findMany = vi.fn();
    expect(await normalizeOwnership({ householdPerson: { findMany } }, 'household', { merchant: 'Shop' }, { ownershipType: 'PERSONAL', personalPersonId: person, shares: [] })).toMatchObject({ personalPersonId: person });
    expect(findMany).not.toHaveBeenCalled();
  });
  it('accepts the identical full ownership payload for historical people without reassigning them', async () => {
    const findMany = vi.fn();
    const existing = { ownershipType: 'SPLIT', personalPersonId: null, shares };
    expect(await normalizeOwnership({ householdPerson: { findMany } }, 'household', { ...existing, shares: [...shares].reverse() }, existing)).toMatchObject({ ownershipType: 'SPLIT' });
    expect(findMany).not.toHaveBeenCalled();
  });
  it.each([
    { ownershipType: 'PERSONAL', personalPersonId: person }, { ownershipType: 'SPLIT', shares },
  ])('rejects participants not in the active household', async (input) => {
    await expect(normalizeOwnership({ householdPerson: { findMany: async () => [] } }, 'household', input)).rejects.toMatchObject({ statusCode: 400, code: 'PURCHASE_PERSON_INVALID' });
  });
  it('queries visibility in all three scopes without OWNER bypass', () => expect(visiblePurchaseWhere('actor')).toEqual({ OR: [
    { ownershipType: 'HOUSEHOLD' }, { ownershipType: 'PERSONAL', personalPerson: { linkedUserId: 'actor' } },
    { ownershipType: 'SPLIT', shares: { some: { householdPerson: { linkedUserId: 'actor' } } } },
  ] }));
  it.each([
    [{ ownershipType: 'HOUSEHOLD' }, true],
    [{ ownershipType: 'PERSONAL', personalPerson: { linkedUserId: 'actor' } }, true],
    [{ ownershipType: 'PERSONAL', personalPerson: { linkedUserId: 'other' } }, false],
    [{ ownershipType: 'SPLIT', shares: [{ householdPerson: { linkedUserId: 'actor' } }] }, true],
    [{ ownershipType: 'SPLIT', shares: [{ householdPerson: { linkedUserId: 'other' } }] }, false],
  ])('visible ownership %j => %s', (purchase, visible) => expect(canViewPurchase(purchase, 'actor')).toBe(visible));
  it('list never serializes identifiers or linked account IDs; detail does expose product identifiers', () => {
    const purchase = { purchaseDate: date, personalPerson: { id: person, name: 'Pablo', linkedUserId: 'secret-user' }, shares: [], items: [{ name: 'Phone', serialNumber: 'ABC123', imei: '123456789', warrantyEndsAt: '2029-09-17' }] };
    const list = serializePurchase(purchase, date, { list: true });
    expect(JSON.stringify(list)).not.toContain('ABC123');
    expect(JSON.stringify(list)).not.toContain('123456789');
    expect(JSON.stringify(list)).not.toContain('secret-user');
    expect(serializePurchase(purchase, date).items[0]).toMatchObject({ serialNumber: 'ABC123', imei: '123456789', warrantyStatus: 'ACTIVE' });
  });
});
