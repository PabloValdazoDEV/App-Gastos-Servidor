import { createHash } from 'node:crypto';

import { sendSuccess } from '../../utils/httpResponses.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import { runSerializableTransaction } from '../household-domain/transaction.js';
import { financeParamsSchema, fundPlanningSchema, revisePlanningSchema, changePlanningExtraSchema, createPlanningExtraSchema, previewPlanningExtraSchema } from './finance.schemas.js';
import { changePlanningExtra, createPlanningExtra, previewPlanningExtra } from './planningExtras.js';
import { calculateHouseholdBudget, jsonValue, sanitizePlanningForViewer } from './finance.service.js';
import { activePlanning, hasFundingConfirmation, planningFunding } from './planningSnapshot.js';

const conflict = (message) => createDomainError(409, 'PLANNING_CHANGED', message);
const versionOf = (planning) => planning.breakdown?.stateVersion ?? 0;

function checkVersion(planning, expected) {
  if (expected === undefined && (planning.breakdown?.revisions?.length ?? 0) > 0) {
    throw conflict('Esta previsión tiene revisiones. Recarga el mes para confirmar sus importes actuales.');
  }
  if (expected !== undefined && expected !== versionOf(planning)) {
    throw conflict('La previsión o sus confirmaciones han cambiado. Recarga el mes y vuelve a revisar la acción.');
  }
}

export function changePlanningFunding(original, body, actorUserId, at = new Date().toISOString()) {
  checkVersion(original, body.expectedVersion);
  const planning = activePlanning(original);
  const ownIds = (planning.breakdown?.personIdentitySnapshot ?? []).filter((item) =>
    item.linkedUserId === actorUserId).map((item) => item.personId);
  if (body.scope === 'PERSONAL' && !planning.contributions.some((item) => ownIds.includes(item.householdPersonId))) {
    throw createDomainError(403, 'PERSONAL_FUNDING_FORBIDDEN', 'Esta previsión no contiene una aportación personal vinculada a tu usuario.');
  }
  const before = structuredClone(original.breakdown?.funding ?? { personal: [] });
  // Normalize legacy FUNDED once before a correction. Otherwise revoking one
  // scope could accidentally remove the other scopes' historical confirmations.
  if (before.version !== 2 && original.fundingStatus === 'FUNDED') {
    const legacy = { at: original.fundedAt?.toISOString?.() ?? original.fundedAt ?? at, by: null, legacy: true };
    before.common ??= legacy;
    before.personal = planning.contributions.map((item) => ({ personId: item.householdPersonId, ...legacy }));
  }
  before.personal ??= [];
  const funding = structuredClone(before);
  const confirmation = { at, by: actorUserId };
  const ids = body.scope === 'ALL' ? planning.contributions.map((item) => item.householdPersonId) : ownIds;
  if (body.action === 'REVOKE') {
    if (body.scope === 'HOUSEHOLD') delete funding.common;
    else funding.personal = funding.personal.filter((item) => !ids.includes(item.personId));
  } else {
    if (body.scope !== 'PERSONAL') funding.common ??= confirmation;
    if (body.scope !== 'HOUSEHOLD') funding.personal.push(...ids.filter((id) =>
      !funding.personal.some((item) => item.personId === id)).map((personId) => ({ personId, ...confirmation })));
  }
  if (JSON.stringify(before) === JSON.stringify(funding)) return null;
  funding.version = 2;
  const events = original.breakdown?.fundingEvents ?? [];
  const breakdown = { ...original.breakdown, funding, stateVersion: versionOf(original) + 1,
    fundingEvents: [...events, { action: body.action, scope: body.scope, at, by: actorUserId,
      revision: original.breakdown?.revisions?.length ?? 0, stateVersion: versionOf(original) + 1,
      personIds: body.scope === 'PERSONAL' ? ids : [], reason: body.reason ?? null,
      // Private audit evidence; the public projection never sends these records.
      before, after: funding }],
  };
  const funded = planning.contributions.every((item) => planningFunding({ ...planning, breakdown }, item).pendingCents === 0);
  return { breakdown: jsonValue(breakdown), fundingStatus: funded ? 'FUNDED' : 'PREPARED', fundedAt: funded ? new Date(at) : null };
}

export function buildPlanningRevision(original, budget, people, actorUserId) {
  const current = activePlanning(original);
  if (original.breakdown?.extras?.some((item) => !item.cancelledAt)) throw conflict('Hay extras acordados. Conserva la previsión inicial o anula primero los extras pendientes; no deshagas transferencias reales.');
  if (hasFundingConfirmation(current)) throw createDomainError(409, 'PLANNING_ALREADY_CONFIRMED',
    'Hay aportaciones confirmadas. La previsión no se puede revisar. Deshaz una confirmación solo si fue un error; no deshagas transferencias reales.');
  if (!budget.readiness.ready) throw conflict('Completa el reparto del hogar antes de revisar la previsión.');
  const identities = original.breakdown?.personIdentitySnapshot;
  if (!Array.isArray(identities) || identities.length !== people.length || identities.some((identity) =>
    !people.some((person) => person.id === identity.personId && person.linkedUserId === identity.linkedUserId))) {
    throw createDomainError(409, 'PLANNING_IDENTITY_CHANGED', 'Las personas vinculadas han cambiado o falta su identidad histórica. Conservamos la previsión original; no se puede revisar automáticamente.');
  }
  if ((original.breakdown?.revisions?.length ?? 0) >= 50) throw conflict('Esta previsión ha alcanzado el límite de 50 revisiones.');
  const ownIds = new Set(identities.filter((identity) => identity.linkedUserId === actorUserId).map((identity) => identity.personId));
  const contributions = current.contributions.map((item) => {
    const next = budget.contributions.find((person) => person.personId === item.householdPersonId);
    if (!next) throw conflict('El reparto ha cambiado. Recarga el mes.');
    // A member may revise shared estimates and their own personal estimates,
    // never the hidden personal forecasts of the other members.
    const personal = ownIds.has(item.householdPersonId) ? next.personalExpenseCents : item.personalExpenseCents;
    return { ...item, contributionBps: next.contributionBps, standardHouseholdCents: next.standardHouseholdCents,
      personalExpenseCents: personal, totalRecommendedCents: next.standardHouseholdCents + personal + item.temporaryAdjustmentCents };
  });
  const personalBudgetCents = contributions.reduce((sum, item) => sum + item.personalExpenseCents, 0);
  const revisedBudget = { ...budget, personalBudgetCents,
    recommendedBudgetCents: budget.householdBudgetCents + personalBudgetCents,
    lines: [...budget.lines.filter((line) => line.scope === 'HOUSEHOLD' || ownIds.has(line.personalPersonId)),
      ...(current.breakdown?.budget?.lines ?? []).filter((line) => line.scope === 'PERSONAL' && !ownIds.has(line.personalPersonId))],
  };
  revisedBudget.personalBaseBudgetCents = revisedBudget.lines.filter((line) => line.scope === 'PERSONAL').reduce((sum, line) => sum + (line.baseCents ?? line.amountCents), 0);
  revisedBudget.personalMarginCents = personalBudgetCents - revisedBudget.personalBaseBudgetCents;
  revisedBudget.contributions = contributions.map((item) => ({ personId: item.householdPersonId,
    personName: item.personName, contributionBps: item.contributionBps, standardHouseholdCents: item.standardHouseholdCents,
    personalExpenseCents: item.personalExpenseCents, totalStandardCents: item.standardHouseholdCents + item.personalExpenseCents }));
  const storedAmounts = [budget.householdBudgetCents, revisedBudget.recommendedBudgetCents,
    ...contributions.flatMap((item) => [item.standardHouseholdCents, item.personalExpenseCents, item.temporaryAdjustmentCents, item.totalRecommendedCents])];
  if (storedAmounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > 2_147_483_647)) {
    throw createDomainError(400, 'PLANNING_AMOUNT_OUT_OF_RANGE', 'El cálculo supera el importe máximo admitido por una previsión. Revisa los gastos antes de guardar.');
  }
  return { householdBudgetCents: budget.householdBudgetCents, recommendedBudgetCents: revisedBudget.recommendedBudgetCents,
    contributions, budget: revisedBudget };
}

function previewRevision(original, snapshot, actorUserId) {
  const candidate = { ...original, fundingStatus: 'PREPARED', breakdown: { ...original.breakdown, funding: { version: 2, personal: [] },
    revisions: [...(original.breakdown?.revisions ?? []), { snapshot }] } };
  const visible = sanitizePlanningForViewer(candidate, actorUserId);
  // The digest covers visible data only: it is not an oracle for private sums.
  const summary = { householdBudgetCents: visible.householdBudgetCents,
    recommendedBudgetCents: visible.recommendedBudgetCents,
    contributions: visible.contributions, budgetLines: visible.budgetLines };
  return { ...summary, expectedVersion: versionOf(original),
    previewFingerprint: createHash('sha256').update(JSON.stringify(summary)).digest('hex') };
}

export function registerPlanningChangeRoutes(router, { prisma, requireCsrf, memberAccess }) {
  async function readPlanning(database, request) {
    const { householdId, planningId } = financeParamsSchema.parse(request.params);
    await memberAccess(database, request);
    const planning = await database.monthlyPlanning.findFirst({ where: { id: planningId, householdId }, include: { contributions: { orderBy: { personName: 'asc' } } } });
    if (!planning) throw createDomainError(404, 'PLANNING_NOT_FOUND', 'No se encontró la planificación.');
    return planning;
  }
  async function calculateRevision(database, original, actorUserId) {
    const { budget, inputs } = await calculateHouseholdBudget(database, original.householdId, original.calculationDate, actorUserId);
    return buildPlanningRevision(original, budget, inputs.household.people, actorUserId);
  }

  router.post('/households/:householdId/plannings/:planningId/extras/preview', requireCsrf, asyncRoute(async (request, response) => {
    const body = previewPlanningExtraSchema.parse(request.body);
    const preview = await runSerializableTransaction(prisma, async (database) =>
      previewPlanningExtra(await readPlanning(database, request), body));
    return sendSuccess(response, preview);
  }));

  async function saveExtra(request, change) {
    return runSerializableTransaction(prisma, async (database) => {
      const original = await readPlanning(database, request);
      const breakdown = change(original);
      if (!breakdown) return original;
      const saved = await database.monthlyPlanning.update({ where: { id: original.id }, data: { breakdown: jsonValue(breakdown) },
        include: { contributions: { orderBy: { personName: 'asc' } } } });
      await createAuditLog(database, { actorUserId: request.auth.userId, householdId: original.householdId,
        action: 'MONTH_PREPARED', resourceType: 'MonthlyPlanning', resourceId: original.id,
        metadata: { operation: 'EXTRA_CHANGED', stateVersion: breakdown.stateVersion } });
      return saved;
    });
  }
  router.post('/households/:householdId/plannings/:planningId/extras', requireCsrf, asyncRoute(async (request, response) => {
    const body = createPlanningExtraSchema.parse(request.body);
    const saved = await saveExtra(request, (original) => createPlanningExtra(original, body, request.auth.userId));
    return sendSuccess(response, sanitizePlanningForViewer(saved, request.auth.userId), { statusCode: 201 });
  }));
  router.patch('/households/:householdId/plannings/:planningId/extras/:extraId', requireCsrf, asyncRoute(async (request, response) => {
    const body = changePlanningExtraSchema.parse(request.body);
    const { extraId } = financeParamsSchema.parse(request.params);
    const saved = await saveExtra(request, (original) => changePlanningExtra(original, extraId, body, request.auth.userId));
    return sendSuccess(response, sanitizePlanningForViewer(saved, request.auth.userId));
  }));

  router.patch('/households/:householdId/plannings/:planningId/fund', requireCsrf, asyncRoute(async (request, response) => {
    const body = fundPlanningSchema.parse(request.body ?? {});
    const planning = await runSerializableTransaction(prisma, async (database) => {
      const original = await readPlanning(database, request);
      const data = changePlanningFunding(original, body, request.auth.userId);
      if (!data) return original;
      const result = await database.monthlyPlanning.update({ where: { id: original.id }, data, include: { contributions: { orderBy: { personName: 'asc' } } } });
      await createAuditLog(database, { actorUserId: request.auth.userId, householdId: original.householdId,
        action: 'MONTH_PREPARED', resourceType: 'MonthlyPlanning', resourceId: original.id,
        metadata: { operation: `FUNDING_${body.action}`, scope: body.scope, stateVersion: data.breakdown.stateVersion } });
      return result;
    });
    return sendSuccess(response, sanitizePlanningForViewer(planning, request.auth.userId));
  }));

  router.get('/households/:householdId/plannings/:planningId/revision-preview', asyncRoute(async (request, response) => {
    const preview = await runSerializableTransaction(prisma, async (database) => {
      const original = await readPlanning(database, request);
      return previewRevision(original, await calculateRevision(database, original, request.auth.userId), request.auth.userId);
    });
    return sendSuccess(response, preview);
  }));

  router.post('/households/:householdId/plannings/:planningId/revisions', requireCsrf, asyncRoute(async (request, response) => {
    const body = revisePlanningSchema.parse(request.body);
    const result = await runSerializableTransaction(prisma, async (database) => {
      const original = await readPlanning(database, request);
      checkVersion(original, body.expectedVersion);
      const snapshot = await calculateRevision(database, original, request.auth.userId);
      const preview = previewRevision(original, snapshot, request.auth.userId);
      if (preview.previewFingerprint !== body.previewFingerprint) throw conflict('El presupuesto ha cambiado desde la vista previa. Vuelve a revisar los importes antes de guardar.');
      const breakdown = { ...original.breakdown, stateVersion: versionOf(original) + 1,
        // Only zero-value confirmations can remain here. Do not let a previous
        // zero confirmation automatically confirm a new, positive estimate.
        funding: { version: 2, personal: [] },
        revisions: [...(original.breakdown?.revisions ?? []), { at: new Date().toISOString(), by: request.auth.userId, reason: body.reason,
          fundingBefore: original.breakdown?.funding ?? null, snapshot }] };
      const saved = await database.monthlyPlanning.update({ where: { id: original.id }, data: { breakdown: jsonValue(breakdown), fundingStatus: 'PREPARED', fundedAt: null }, include: { contributions: { orderBy: { personName: 'asc' } } } });
      await createAuditLog(database, { actorUserId: request.auth.userId, householdId: original.householdId,
        action: 'MONTH_PREPARED', resourceType: 'MonthlyPlanning', resourceId: original.id,
        metadata: { operation: 'REVISION', revision: breakdown.revisions.length, stateVersion: breakdown.stateVersion } });
      return saved;
    });
    return sendSuccess(response, sanitizePlanningForViewer(result, request.auth.userId), { statusCode: 201 });
  }));
}
