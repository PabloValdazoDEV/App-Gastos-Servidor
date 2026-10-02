import { splitAmount } from '../../services/money.service.js';
import { createDomainError } from '../household-domain/domainError.js';
import { activePlanning } from './planningSnapshot.js';

const conflict = (message) => createDomainError(409, 'PLANNING_CHANGED', message);
export function checkExtraVersion(planning, expectedVersion) {
  if (expectedVersion !== (planning.breakdown?.stateVersion ?? 0)) {
    throw conflict('Las aportaciones han cambiado. Cierra esta acción y vuelve a revisar el mes.');
  }
}

export function previewPlanningExtra(original, body) {
  checkExtraVersion(original, body.expectedVersion);
  const planning = activePlanning(original);
  const people = planning.contributions;
  if (!people.length || people.reduce((sum, item) => sum + item.contributionBps, 0) !== 10000) {
    throw conflict('El reparto guardado no suma el 100 %. No se puede acordar un extra con este reparto.');
  }
  const agreed = (original.breakdown?.extras ?? []).filter((item) => !item.cancelledAt)
    .reduce((sum, item) => sum + item.amountCents, 0);
  if (agreed + body.amountCents > 2_147_483_647) throw conflict('Los extras del mes superan el importe máximo admitido.');
  const shares = splitAmount(body.amountCents, people.map((item) => ({ id: item.householdPersonId, contributionBps: item.contributionBps })));
  return { amountCents: body.amountCents, expectedVersion: body.expectedVersion,
    shares: shares.map(({ id, amountCents }) => ({ personId: id, amountCents,
      personName: people.find((item) => item.householdPersonId === id).personName })) };
}

// Extras are a separate shared ledger, never additional expenses or bank movements.
export function createPlanningExtra(original, body, actorUserId, at = new Date().toISOString()) {
  const existing = (original.breakdown?.extras ?? []).find((item) => item.id === body.id);
  if (existing) {
    if (existing.amountCents === body.amountCents && existing.reason === body.reason && existing.by === actorUserId) return null;
    throw conflict('Ese identificador ya corresponde a otro extra. Recarga el mes.');
  }
  const preview = previewPlanningExtra(original, body);
  if ((original.breakdown?.extras?.length ?? 0) >= 100) throw conflict('El mes ha alcanzado el límite de 100 extras, incluidos los anulados.');
  return { ...original.breakdown, stateVersion: body.expectedVersion + 1,
    extras: [...(original.breakdown?.extras ?? []), { id: body.id, amountCents: body.amountCents,
      reason: body.reason, at, by: actorUserId, revision: original.breakdown?.revisions?.length ?? 0,
      shares: preview.shares, events: [] }] };
}

export function changePlanningExtra(original, extraId, body, actorUserId, at = new Date().toISOString()) {
  checkExtraVersion(original, body.expectedVersion);
  const extras = structuredClone(original.breakdown?.extras ?? []);
  const extra = extras.find((item) => item.id === extraId);
  if (!extra) throw createDomainError(404, 'EXTRA_NOT_FOUND', 'No se encontró esta aportación extra en el mes.');
  if (extra.cancelledAt) throw conflict('Este extra ya está anulado.');
  if (body.action === 'CANCEL') {
    if (extra.shares.some((item) => item.confirmedAt)) throw conflict('Hay dinero confirmado. No se puede anular el extra; corrige una confirmación solo si fue un error.');
    extra.cancelledAt = at;
  } else {
    const share = extra.shares.find((item) => item.personId === body.personId && item.amountCents > 0);
    if (!share) throw createDomainError(400, 'EXTRA_PERSON_INVALID', 'Esta persona no tiene una aportación en este extra.');
    if (body.action === 'CONFIRM') {
      if (share.confirmedAt) return null;
      share.confirmedAt = at;
    } else {
      if (!share.confirmedAt) return null;
      delete share.confirmedAt;
    }
  }
  extra.events.push({ action: body.action, personId: body.personId ?? null, reason: body.reason ?? null, at, by: actorUserId });
  return { ...original.breakdown, stateVersion: body.expectedVersion + 1, extras };
}

export function publicPlanningExtras(planning) {
  return (planning.breakdown?.extras ?? []).map((extra) => ({ id: extra.id, amountCents: extra.amountCents,
    reason: extra.reason, at: extra.at, revision: extra.revision, cancelledAt: extra.cancelledAt ?? null,
    shares: extra.shares.map(({ personId, personName, amountCents, confirmedAt }) => ({ personId, personName, amountCents, confirmedAt: confirmedAt ?? null })),
    events: extra.events.map(({ action, personId, reason, at }) => ({ action, personId, reason, at })) }));
}

export function extraFunding(extras, personId) {
  const shares = extras.filter((item) => !item.cancelledAt).flatMap((item) => item.shares)
    .filter((item) => !personId || item.personId === personId);
  const agreedCents = shares.reduce((sum, item) => sum + item.amountCents, 0);
  const confirmedCents = shares.reduce((sum, item) => sum + (item.confirmedAt ? item.amountCents : 0), 0);
  return { agreedCents, confirmedCents, pendingCents: agreedCents - confirmedCents };
}
