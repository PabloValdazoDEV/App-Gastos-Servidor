import { describe, expect, it } from 'vitest';
import { changePlanningExtra, createPlanningExtra, previewPlanningExtra } from '../src/modules/finance/planningExtras.js';
import { sanitizePlanningForViewer } from '../src/modules/finance/finance.service.js';
import { buildPlanningRevision, changePlanningFunding } from '../src/modules/finance/planningChanges.js';
import { changePlanningExtraSchema, createPlanningExtraSchema } from '../src/modules/finance/finance.schemas.js';

const at = '2026-10-01T12:00:00.000Z';
const body = { id: 'extra', expectedVersion: 0, amountCents: 8000, reason: 'Gasto imprevisto' };
function fixture() {
  return { fundingStatus: 'FUNDED', householdBudgetCents: 100000, recommendedBudgetCents: 110000,
    contributions: ['a', 'b'].map((id) => ({ id, householdPersonId: id, personName: id, contributionBps: 5000,
      standardHouseholdCents: 50000, temporaryAdjustmentCents: 0, personalExpenseCents: 5000, totalRecommendedCents: 55000 })),
    breakdown: { personIdentitySnapshot: [{ personId: 'a', linkedUserId: 'alice' }, { personId: 'b', linkedUserId: 'bob' }] } };
}
const withExtra = () => { const original = fixture(); return { ...original, breakdown: createPlanningExtra(original, body, 'alice', at) }; };

describe('separate shared extra contributions', () => {
  it('keeps initial funded contributions unchanged and starts the extra pending, even for legacy FUNDED', () => {
    const original = fixture();
    const before = structuredClone(original);
    const result = { ...original, breakdown: createPlanningExtra(original, body, 'alice', at) };
    const visible = sanitizePlanningForViewer(result, 'alice');
    expect(visible.extraFunding).toEqual({ agreedCents: 8000, confirmedCents: 0, pendingCents: 8000 });
    expect(visible.contributions[0]).toMatchObject({ totalRecommendedCents: 55000, totalConfirmedCents: 55000, totalPendingCents: 4000 });
    expect(visible.contributions[1]).toMatchObject({ personalAmountsHidden: true, personalExpenseCents: 0, totalConfirmedCents: 50000, totalPendingCents: 4000 });
    expect(visible.canRevise).toBe(false);
    expect(visible.breakdown).toBeNull();
    expect(JSON.stringify(visible.extras)).not.toContain('alice');
    expect(original).toEqual(before);
    expect(result.contributions).toEqual(before.contributions);
    expect(createPlanningExtra(result, body, 'alice', at)).toBeNull();
    expect(() => createPlanningExtra(result, { ...body, amountCents: 1 }, 'alice')).toThrow(/identificador/);
  });

  it('confirms only the named share and preserves history when correcting or cancelling', () => {
    const original = withExtra();
    const confirmed = { ...original, breakdown: changePlanningExtra(original, 'extra', { action: 'CONFIRM', expectedVersion: 1, personId: 'a' }, 'bob', at) };
    const view = sanitizePlanningForViewer(confirmed, 'alice');
    expect(view.extraFunding).toEqual({ agreedCents: 8000, confirmedCents: 4000, pendingCents: 4000 });
    expect(view.contributions.map((item) => item.totalPendingCents)).toEqual([0, 4000]);
    expect(changePlanningExtra(confirmed, 'extra', { action: 'CONFIRM', expectedVersion: 2, personId: 'a' }, 'bob')).toBeNull();
    expect(() => changePlanningExtra(confirmed, 'extra', { action: 'CANCEL', expectedVersion: 2, reason: 'Anular' }, 'bob')).toThrow(/dinero confirmado/);
    const undo = { ...confirmed, breakdown: changePlanningExtra(confirmed, 'extra', { action: 'REVOKE', expectedVersion: 2, personId: 'a', reason: 'Fue un error' }, 'alice', at) };
    expect(sanitizePlanningForViewer(undo, 'alice').contributions[0].totalPendingCents).toBe(4000);
    const cancelled = { ...undo, breakdown: changePlanningExtra(undo, 'extra', { action: 'CANCEL', expectedVersion: 3, reason: 'Lo cubre el colchón' }, 'alice', at) };
    expect(sanitizePlanningForViewer(cancelled, 'alice').extraFunding).toEqual({ agreedCents: 0, confirmedCents: 0, pendingCents: 0 });
    expect(cancelled.breakdown.extras[0].events.map((item) => item.action)).toEqual(['CONFIRM', 'REVOKE', 'CANCEL']);
    expect(() => changePlanningExtra(cancelled, 'extra', { action: 'CONFIRM', expectedVersion: 4, personId: 'a' }, 'alice')).toThrow(/anulado/);
  });

  it('rejects stale state, unrelated people/extras, invalid amounts and missing correction reasons', () => {
    const planning = withExtra();
    expect(() => previewPlanningExtra(planning, body)).toThrow(/han cambiado/);
    expect(() => changePlanningExtra(planning, 'other', { expectedVersion: 1, action: 'CANCEL' }, 'alice')).toThrow(/No se encontró/);
    expect(() => changePlanningExtra(planning, 'extra', { expectedVersion: 1, action: 'CONFIRM', personId: 'outsider' }, 'alice')).toThrow(/no tiene/);
    for (const amountCents of [-1, 0, 1.5, 2_147_483_648]) expect(createPlanningExtraSchema.safeParse({ ...body, id: crypto.randomUUID(), amountCents }).success).toBe(false);
    expect(changePlanningExtraSchema.safeParse({ action: 'REVOKE', expectedVersion: 1, personId: crypto.randomUUID() }).success).toBe(false);
    expect(changePlanningExtraSchema.safeParse({ action: 'CANCEL', expectedVersion: 1, reason: 'ok', personId: crypto.randomUUID() }).success).toBe(false);
  });

  it('uses saved shares with exact cent allocation, including zero percentages, and no live budget dependency', () => {
    const original = fixture();
    original.contributions.push({ householdPersonId: 'c', personName: 'c', contributionBps: 0 });
    expect(previewPlanningExtra(original, { expectedVersion: 0, amountCents: 1 }).shares.map((item) => item.amountCents)).toEqual([1, 0, 0]);
    original.contributions[0].contributionBps = 6000;
    expect(() => previewPlanningExtra(original, body)).toThrow(/100 %/);
  });

  it('blocks rebasing while extras are active, and initial confirmation never confirms an extra', () => {
    const original = { ...withExtra(), fundingStatus: 'PREPARED' };
    expect(() => buildPlanningRevision(original, {}, [], 'alice')).toThrow(/extras acordados/);
    const confirmed = { ...original, ...changePlanningFunding(original, { action: 'CONFIRM', scope: 'ALL', expectedVersion: 1 }, 'alice', at) };
    expect(sanitizePlanningForViewer(confirmed, 'alice').extraFunding.pendingCents).toBe(8000);
  });
});
