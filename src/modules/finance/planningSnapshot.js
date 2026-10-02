// Funding confirmations belong to the frozen plan, never to a live estimate.
export function planningFunding(planning, contribution) {
  const records = planning.breakdown?.funding;
  const legacyFunded = records?.version !== 2 && planning.fundingStatus === 'FUNDED';
  const commonConfirmed = legacyFunded || Boolean(records?.common);
  const personalConfirmed = legacyFunded || Boolean(records?.personal?.some(
    (record) => record.personId === contribution.householdPersonId,
  ));
  const common = (contribution.standardHouseholdCents ?? 0) + (contribution.temporaryAdjustmentCents ?? 0);
  const personal = contribution.personalExpenseCents ?? 0;
  const confirmedCents = (commonConfirmed ? common : 0) + (personalConfirmed ? personal : 0);
  return { commonConfirmed, personalConfirmed, confirmedCents, pendingCents: common + personal - confirmedCents };
}

// Revisions overlay the original immutable rows. Never persist this projected
// object over the original planning or its contributions.
export function activePlanning(planning) {
  if (!planning) return planning;
  const revisions = planning.breakdown?.revisions ?? [];
  const snapshot = revisions.at(-1)?.snapshot;
  if (!snapshot) return planning;
  return {
    ...planning,
    householdBudgetCents: snapshot.householdBudgetCents,
    recommendedBudgetCents: snapshot.recommendedBudgetCents,
    contributions: snapshot.contributions,
    breakdown: { ...planning.breakdown, budget: snapshot.budget },
  };
}

export function hasFundingConfirmation(planning) {
  return (planning.contributions ?? []).some((item) => {
    const funding = planningFunding(planning, item);
    return funding.confirmedCents > 0;
  });
}

export function publicBudgetLines(lines = [], canViewPersonal) {
  return lines.filter((line) => line.scope === 'HOUSEHOLD' || canViewPersonal(line.personalPersonId))
    .map(({ id, name, type, scope, personalPersonId, baseCents, amountCents, estimatedClosingMonth }) => ({
      id, name, type, scope, personalPersonId, baseCents, amountCents, estimatedClosingMonth,
    }));
}

export function comparePlanningBudget(planning, budget) {
  const oldLines = planning.budgetLines ?? [];
  const key = (line) => `${line.type}:${line.id}`;
  const previous = new Map(oldLines.map((line) => [key(line), line]));
  const current = new Map((budget.lines ?? []).map((line) => [key(line), line]));
  const changes = [...new Set([...previous.keys(), ...current.keys()])].flatMap((id) => {
    const before = previous.get(id);
    const after = current.get(id);
    const differenceCents = (after?.amountCents ?? 0) - (before?.amountCents ?? 0);
    if (!differenceCents) return [];
    return [{ id, name: after?.name ?? before?.name ?? 'Gasto', scope: after?.scope ?? before?.scope,
      previousCents: before?.amountCents ?? 0, currentCents: after?.amountCents ?? 0, differenceCents }];
  });
  return {
    householdDifferenceCents: (budget.householdBudgetCents ?? 0) - (planning.householdBudgetCents ?? 0),
    // Missing historical identities mean private historical amounts are unknown,
    // not zero. Do not invent a personal difference in that case.
    personalDifferenceCents: planning.personalHistoryRequiresConfirmation ? null :
      ((budget.recommendedBudgetCents ?? 0) - (budget.householdBudgetCents ?? 0)) -
      ((planning.recommendedBudgetCents ?? 0) - (planning.householdBudgetCents ?? 0)),
    lines: oldLines.length ? changes.filter((line) =>
      !planning.personalHistoryRequiresConfirmation || line.scope === 'HOUSEHOLD') : [],
  };
}
