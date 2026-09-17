export function budgetMarginOwnerKey({ scope, personalPersonId }) {
  return scope === 'PERSONAL' ? personalPersonId.toLowerCase() : 'HOUSEHOLD';
}

export function budgetMarginGroupKey(expenseType, group) {
  return `${expenseType}:${group.categoryId}:${budgetMarginOwnerKey(group)}`;
}

export function budgetMarginLookup(preferences) {
  const enabledGroups = new Set(preferences
    .filter((preference) => preference.applySafetyMargin === true)
    .map((preference) => budgetMarginGroupKey(preference.expenseType, preference)));
  return (expenseType, group) => enabledGroups.has(budgetMarginGroupKey(expenseType, group));
}
