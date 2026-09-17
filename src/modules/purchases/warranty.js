import { addCalendarMonths, differenceInCalendarDays, toCivilDate, toIsoDate } from '../../services/date.service.js';
import { createDomainError } from '../household-domain/domainError.js';
import { serializePurchasePayment } from './purchasePayments.js';

export const WARRANTY_EXPIRING_SOON_DAYS = 60;

export function warrantyFields(input, purchaseDate) {
  // An explicit non-null date wins. Null date + duration selects calendar months.
  if (input.warrantyEndsAt != null) {
    return { warrantySource: 'EXPLICIT_DATE', warrantyDurationMonths: null, warrantyEndsAt: toCivilDate(input.warrantyEndsAt) };
  }
  if (input.warrantyDurationMonths != null) {
    const warrantyEndsAt = addCalendarMonths(purchaseDate, input.warrantyDurationMonths);
    if (warrantyEndsAt.getUTCFullYear() > 9999) throw createDomainError(400, 'WARRANTY_DATE_OUT_OF_RANGE', 'La garantía debe terminar como máximo en el año 9999.');
    return {
      warrantySource: 'DURATION', warrantyDurationMonths: input.warrantyDurationMonths,
      warrantyEndsAt,
    };
  }
  return { warrantySource: null, warrantyDurationMonths: null, warrantyEndsAt: null };
}

export function warrantyState(warrantyEndsAt, today) {
  if (!warrantyEndsAt) return { warrantyStatus: 'NONE', warrantyDaysRemaining: null };
  const days = differenceInCalendarDays(warrantyEndsAt, today);
  return {
    warrantyStatus: days < 0 ? 'EXPIRED' : days <= WARRANTY_EXPIRING_SOON_DAYS ? 'EXPIRING_SOON' : 'ACTIVE',
    warrantyDaysRemaining: days,
  };
}

export function householdToday(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return toCivilDate(`${get('year')}-${get('month')}-${get('day')}`);
}

export function serializePurchase(purchase, today, { list = false } = {}) {
  const publicPurchase = { ...purchase };
  delete publicPurchase.paymentAllocationSnapshot;
  return {
    ...publicPurchase,
    purchaseDate: toIsoDate(purchase.purchaseDate),
    ...serializePurchasePayment(purchase, { list }),
    personalPerson: purchase.personalPerson ? { id: purchase.personalPerson.id, name: purchase.personalPerson.name } : null,
    shares: purchase.shares.map((share) => ({
      id: share.id, householdPersonId: share.householdPersonId, shareBps: share.shareBps,
      householdPerson: { id: share.householdPerson.id, name: share.householdPerson.name },
    })),
    items: purchase.items.map((item) => {
      const { serialNumber, imei, ...publicItem } = item;
      return {
        ...publicItem,
        ...(!list ? { serialNumber, imei } : {}),
        warrantyEndsAt: item.warrantyEndsAt ? toIsoDate(item.warrantyEndsAt) : null,
        ...warrantyState(item.warrantyEndsAt, today),
      };
    }),
  };
}
