import { describe, expect, it } from 'vitest';

import { buildPlanningRevision, changePlanningFunding } from '../src/modules/finance/planningChanges.js';
import { sanitizePlanningForViewer } from '../src/modules/finance/finance.service.js';
import { activePlanning, planningFunding } from '../src/modules/finance/planningSnapshot.js';
import { fundPlanningSchema } from '../src/modules/finance/finance.schemas.js';

const people = [{ id: 'a', linkedUserId: 'alice' }, { id: 'b', linkedUserId: 'bob' }];
function fixture() {
  return { id: 'plan', fundingStatus: 'PREPARED', householdBudgetCents: 10000, recommendedBudgetCents: 16000,
    contributions: people.map((person, index) => ({ id: person.id, householdPersonId: person.id, personName: person.id,
      standardHouseholdCents: 5000, temporaryAdjustmentCents: 1000, personalExpenseCents: index ? 4000 : 2000,
      contributionBps: 5000, totalRecommendedCents: index ? 10000 : 8000 })),
    breakdown: { personIdentitySnapshot: people.map((person) => ({ personId: person.id, linkedUserId: person.linkedUserId })),
      budget: { lines: [{ id: 'private-b', name: 'Private secret B', scope: 'PERSONAL', personalPersonId: 'b', amountCents: 4000, baseCents: 4000 }] } } };
}
function budget() {
  return { readiness: { ready: true }, householdBudgetCents: 20000, personalBudgetCents: 3000, recommendedBudgetCents: 23000,
    contributions: [{ personId: 'a', contributionBps: 5000, standardHouseholdCents: 10000, personalExpenseCents: 3000 },
      { personId: 'b', contributionBps: 5000, standardHouseholdCents: 10000, personalExpenseCents: 0 }],
    lines: [{ id: 'common', scope: 'HOUSEHOLD', amountCents: 20000, baseCents: 20000 },
      { id: 'private-a', scope: 'PERSONAL', personalPersonId: 'a', amountCents: 3000, baseCents: 3000 }] };
}
const at = '2026-10-01T12:00:00.000Z';

describe('planning corrections', () => {
  it('undoes only personal confirmation, with history, no balance changes and no mutation of original objects', () => {
    const original = fixture();
    const copy = structuredClone(original);
    const paid = { ...original, ...changePlanningFunding(original, { action: 'CONFIRM', scope: 'ALL' }, 'alice', at) };
    expect(paid.fundingStatus).toBe('FUNDED');
    const undo = changePlanningFunding(paid, { action: 'REVOKE', scope: 'PERSONAL', expectedVersion: 1, reason: 'Error de confirmación' }, 'alice', at);
    const corrected = { ...paid, ...undo };
    expect(planningFunding(corrected, original.contributions[0])).toMatchObject({ commonConfirmed: true, personalConfirmed: false, pendingCents: 2000 });
    expect(planningFunding(corrected, original.contributions[1])).toMatchObject({ personalConfirmed: true, pendingCents: 0 });
    expect(undo.breakdown.fundingEvents).toHaveLength(2);
    expect(undo).not.toHaveProperty('contributions');
    expect(undo).not.toHaveProperty('confirmedBalanceCents');
    expect(original).toEqual(copy);
    expect(sanitizePlanningForViewer(corrected, 'bob').fundingHistory).toHaveLength(1);
    expect(JSON.stringify(sanitizePlanningForViewer(corrected, 'bob'))).not.toContain('Error de confirmación');
    expect(changePlanningFunding(corrected, { action: 'REVOKE', scope: 'PERSONAL', expectedVersion: 2 }, 'alice', at)).toBeNull();
  });

  it('rejects stale versions and personal actions for an unlinked actor', () => {
    expect(() => changePlanningFunding(fixture(), { action: 'REVOKE', scope: 'HOUSEHOLD', expectedVersion: 7 }, 'alice')).toThrow(/han cambiado/);
    expect(() => changePlanningFunding(fixture(), { action: 'REVOKE', scope: 'PERSONAL', expectedVersion: 0 }, 'outsider')).toThrow(/vinculada/);
  });

  it('normalizes legacy FUNDED without losing personal confirmations when undoing the common scope', () => {
    const original = { ...fixture(), fundingStatus: 'FUNDED', fundedAt: new Date(at) };
    const corrected = { ...original, ...changePlanningFunding(original, { action: 'REVOKE', scope: 'HOUSEHOLD', expectedVersion: 0 }, 'alice', at) };
    expect(corrected.fundingStatus).toBe('PREPARED');
    for (const person of corrected.contributions) expect(planningFunding(corrected, person)).toMatchObject({ commonConfirmed: false, personalConfirmed: true, pendingCents: 6000 });
    expect(corrected.breakdown.fundingEvents[0].before.common.legacy).toBe(true);
  });

  it('keeps the original snapshot and other personal estimates while revising shared and own estimates', () => {
    const original = fixture();
    const copy = structuredClone(original);
    const snapshot = buildPlanningRevision(original, budget(), people, 'alice');
    expect(snapshot.recommendedBudgetCents).toBe(27000);
    expect(snapshot.contributions.map((item) => item.personalExpenseCents)).toEqual([3000, 4000]);
    expect(snapshot.contributions.map((item) => item.totalRecommendedCents)).toEqual([14000, 15000]);
    const persisted = { ...original, breakdown: { ...original.breakdown, revisions: [{ snapshot, at, reason: 'Nuevo presupuesto' }] } };
    expect(activePlanning(persisted).householdBudgetCents).toBe(20000);
    expect(persisted.householdBudgetCents).toBe(10000);
    const visible = sanitizePlanningForViewer(persisted, 'alice');
    expect(visible.revisionHistory.map((item) => item.householdBudgetCents)).toEqual([10000, 20000]);
    expect(visible.revisionHistory[1].contributions[1]).toMatchObject({ personalAmountsHidden: true, personalExpenseCents: 0, totalRecommendedCents: 11000 });
    expect(JSON.stringify(visible)).not.toContain('Private secret B');
    expect(original).toEqual(copy);
    expect(() => changePlanningFunding(persisted, { action: 'CONFIRM', scope: 'HOUSEHOLD' }, 'alice')).toThrow(/tiene revisiones/);
  });

  it('never recalculates confirmed money or reassigns frozen private identities', () => {
    const original = fixture();
    const funded = { ...original, ...changePlanningFunding(original, { action: 'CONFIRM', scope: 'PERSONAL' }, 'bob', at) };
    expect(() => buildPlanningRevision(funded, budget(), people, 'alice')).toThrow(/Hay aportaciones confirmadas/);
    expect(() => buildPlanningRevision(original, budget(), [{ ...people[0], linkedUserId: 'new-user' }, people[1]], 'alice')).toThrow(/personas vinculadas/);
    const legacy = fixture();
    delete legacy.breakdown.personIdentitySnapshot;
    expect(() => buildPlanningRevision(legacy, budget(), people, 'alice')).toThrow(/identidad histórica/);
  });

  it('requires a reason and version to undo and forbids undoing every personal scope at once', () => {
    expect(fundPlanningSchema.safeParse({ scope: 'ALL', action: 'REVOKE', expectedVersion: 0, reason: 'Error' }).success).toBe(false);
    expect(fundPlanningSchema.safeParse({ scope: 'PERSONAL', action: 'REVOKE' }).success).toBe(false);
    expect(fundPlanningSchema.safeParse({ scope: 'PERSONAL', action: 'REVOKE', expectedVersion: 0, reason: 'Error' }).success).toBe(true);
    expect(fundPlanningSchema.parse({})).toMatchObject({ action: 'CONFIRM', scope: 'ALL' });
  });

  it('enforces the same monetary range as the original stored contribution rows', () => {
    const excessive = budget();
    excessive.contributions[0].personalExpenseCents = 2_147_483_647;
    expect(() => buildPlanningRevision(fixture(), excessive, people, 'alice')).toThrow(/importe máximo/);
  });
});
