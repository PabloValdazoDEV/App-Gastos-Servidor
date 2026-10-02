import { describe, expect, it } from 'vitest';
import { sanitizePlanningForViewer, rebasePlanningToBudget, calculateBudgetFromInputs, planningMatchesBudget } from '../src/modules/finance/finance.service.js';
import { withBusinessDate } from '../src/services/businessClock.service.js';

const contribution = { householdPersonId: 'own', standardHouseholdCents: 50000, temporaryAdjustmentCents: 1000, personalExpenseCents: 20000, totalRecommendedCents: 71000 };
const snapshot = () => ({ householdBudgetCents: 51000, recommendedBudgetCents: 71000, fundingStatus: 'PREPARED', contributions: [contribution], breakdown: {
  personIdentitySnapshot: [{ personId: 'own', linkedUserId: 'viewer' }],
  budget: { lines: [
    { id: 'common', type: 'RECURRING', name: 'Seguro', scope: 'HOUSEHOLD', amountCents: 50000 },
    { id: 'own', type: 'ONE_TIME', name: 'Propio', scope: 'PERSONAL', personalPersonId: 'own', amountCents: 20000, statistics: { secret: true } },
    { id: 'secret', type: 'ONE_TIME', name: 'Privado ajeno', scope: 'PERSONAL', personalPersonId: 'other', amountCents: 987654 },
  ] },
} });

describe('frozen planning and funding', () => {
  it('detects offsetting line changes even when the total stays unchanged', () => {
    const old = { householdBudgetCents: 10000, recommendedBudgetCents: 10000, contributions: [], budgetLines: [
      { id: 'a', type: 'VARIABLE', amountCents: 4000 }, { id: 'b', type: 'VARIABLE', amountCents: 6000 },
    ] };
    expect(planningMatchesBudget(old, { ...old, lines: [
      { id: 'a', type: 'VARIABLE', amountCents: 5000 }, { id: 'b', type: 'VARIABLE', amountCents: 5000 },
    ] })).toBe(false);
  });
  it('keeps confirmed amounts and exposes signed itemized differences separately', () => {
    const saved = sanitizePlanningForViewer(snapshot(), 'viewer');
    const before = structuredClone(saved);
    const result = rebasePlanningToBudget(saved, { householdBudgetCents: 51000, recommendedBudgetCents: 81000, lines: [{ id: 'common', type: 'RECURRING', name: 'Seguro', scope: 'HOUSEHOLD', amountCents: 50000 }, { id: 'own', type: 'ONE_TIME', name: 'Propio', scope: 'PERSONAL', amountCents: 30000 }] });
    expect(result.contributions).toEqual(before.contributions);
    expect(result.recommendedBudgetCents).toBe(71000);
    expect(result.budgetComparison).toMatchObject({ householdDifferenceCents: 0, personalDifferenceCents: 10000, lines: [{ name: 'Propio', differenceCents: 10000 }] });
    expect(saved).toEqual(before);
  });

  it('redacts all foreign private lines, identities and nested invoice statistics', () => {
    const result = sanitizePlanningForViewer(snapshot(), 'viewer');
    expect(JSON.stringify(result)).not.toMatch(/987654|Privado ajeno|secret|linkedUserId/);
    expect(result.budgetLines).toHaveLength(2);
    expect(result.contributions[0]).toMatchObject({ canConfirmPersonal: true, funding: { confirmedCents: 0, pendingCents: 71000 } });
    expect(sanitizePlanningForViewer(snapshot(), 'new-viewer').contributions[0]).toMatchObject({ canConfirmPersonal: false, personalAmountsHidden: true, personalExpenseCents: 0, funding: { pendingCents: 51000 } });
    const legacy = snapshot();
    delete legacy.breakdown.personIdentitySnapshot;
    expect(sanitizePlanningForViewer(legacy, 'viewer').contributions[0].personalAmountsHidden).toBe(true);
  });

  it('separates common and personal confirmations, includes adjustment, preserves legacy funded state', () => {
    const plan = snapshot();
    plan.breakdown.funding = { common: { at: '2026-10-29' }, personal: [] };
    expect(sanitizePlanningForViewer(plan, 'viewer').contributions[0].funding).toMatchObject({ confirmedCents: 51000, pendingCents: 20000 });
    plan.breakdown.funding.personal.push({ personId: 'own', at: '2026-10-29' });
    expect(sanitizePlanningForViewer(plan, 'viewer').contributions[0].funding.pendingCents).toBe(0);
    delete plan.breakdown.funding;
    plan.fundingStatus = 'FUNDED';
    expect(sanitizePlanningForViewer(plan, 'viewer').contributions[0].funding).toMatchObject({ confirmedCents: 71000, pendingCents: 0 });
  });

  it('does not treat a salary month outside the closing window as completed history', () => withBusinessDate('2026-10-27', () => {
    const result = calculateBudgetFromInputs({
      household: { contributionMode: 'PERCENTAGE', people: [{ id: 'own', name: 'Pablo', isActive: true, contributionBps: 10000 }], safetyMarginBps: 0 },
      recurringExpenses: [], invoiceGroups: [], oneTimeExpenses: [
        { id: 'old', name: 'Septiembre', expenseDate: '2026-09-10', amountCents: 120000 },
        { id: 'new', name: 'Noviembre', expenseDate: '2026-11-30', amountCents: 5000 },
      ], variableGroups: [{ categoryId: 'food', scope: 'HOUSEHOLD', months: [
        { year: 2026, month: 9, entryMode: 'SUMMARY', summaryAmountCents: 40000 },
        { year: 2026, month: 10, entryMode: 'SUMMARY', summaryAmountCents: 1000 },
      ] }],
    }, '2026-11-01');
    expect(result.lines.map((line) => line.amountCents)).toEqual([40000, 5000]);
    expect(result.householdBudgetCents).toBe(45000);
  }));
});
