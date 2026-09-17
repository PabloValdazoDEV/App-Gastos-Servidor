import { toCivilDate } from './date.service.js';
import { assertSafeInteger, roundDivide } from './money.service.js';

const NEAR_LIMIT_BPS = 8_000n;

function nonNegativeCents(value, name) {
  assertSafeInteger(value, name);
  if (value < 0) throw new RangeError(`${name} no puede ser negativo.`);
  return value;
}

function safeNumber(value, name) {
  return assertSafeInteger(Number(value), name);
}

function progressFor(budgetCents, used, name) {
  nonNegativeCents(budgetCents, `${name}.budgetCents`);
  const budget = BigInt(budgetCents);
  const rawRemaining = budget - used;
  const status = used > budget
    ? 'OVER_BUDGET'
    : budget > 0n && used * 10_000n >= budget * NEAR_LIMIT_BPS
      ? 'NEAR_LIMIT'
      : 'WITHIN_BUDGET';

  return {
    budgetCents,
    usedCents: safeNumber(used, `${name}.usedCents`),
    rawRemainingCents: safeNumber(rawRemaining, `${name}.rawRemainingCents`),
    remainingCents: safeNumber(rawRemaining > 0n ? rawRemaining : 0n, `${name}.remainingCents`),
    overBudgetCents: safeNumber(rawRemaining < 0n ? -rawRemaining : 0n, `${name}.overBudgetCents`),
    // No finite percentage exists for spending against a zero budget. Keep the
    // amount and OVER_BUDGET status, but never serialize Infinity or a false 0%.
    progressBps: budget > 0n ? roundDivide(used * 10_000n, budget) : used > 0n ? null : 0,
    status,
  };
}

function coverageFor(balanceCents, remainingBudgetCents, name) {
  assertSafeInteger(balanceCents, `${name}.balanceCents`);
  const cushion = BigInt(balanceCents) - BigInt(remainingBudgetCents);
  return {
    balanceCents,
    remainingBudgetCents,
    cushionCents: safeNumber(cushion, `${name}.cushionCents`),
    shortfallCents: safeNumber(cushion < 0n ? -cushion : 0n, `${name}.shortfallCents`),
    status: cushion >= 0n ? 'COVERED' : 'SHORTFALL',
  };
}

/**
 * Budget consumption and registered-account coverage are separate concepts.
 * Budgets are the existing recommendations, already including effective margins;
 * only actual, materialized amounts contribute to usedCents below.
 *
 * The caller must load only the current household's visible records. As a second
 * privacy boundary, personal rows are accepted ONLY for the explicit viewer ID;
 * missing/unknown scopes never default to HOUSEHOLD. No viewer total is produced.
 *
 * All dates are civil @db.Date values, normalized by the existing UTC helpers:
 * payments belong to dueDate's month (not paymentDate); variables to year/month;
 * invoices to chargeDate, falling back to invoiceDate, never their service period.
 * Purchase cash outflows instead belong to paidAt's month. Their scheduled
 * budget remains in dueDate's month; an early payment does not rewrite it.
 *
 * OneTimeExpense is deliberately not an input: it is a budget commitment, not
 * evidence of payment. It remains in the supplied budget until a real payment
 * mechanism exists. Neither that mechanism nor any bank movement is inferred.
 */
export function calculateMonthlySpendingProgress({
  calculationDate,
  commonBudgetCents,
  personalBudgetCents = null,
  viewerPersonId = null,
  includeViewerPurchaseHistory = false,
  payments = [],
  variableMonths = [],
  invoices = [],
  purchaseSources = [],
  commonBalanceCents,
  personalBalanceCents = null,
}) {
  // Missing budget configuration is not a configured zero budget.
  if (commonBudgetCents === null) return { monthlyProgress: null, cashCoverage: null };

  const date = toCivilDate(calculationDate);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const used = { common: 0n, personal: 0n };
  const hasPersonalBudget = (Boolean(viewerPersonId) || includeViewerPurchaseHistory) && personalBudgetCents !== null;
  const scopeFor = (record) => {
    if (record?.scope === 'HOUSEHOLD') return 'common';
    if (
      hasPersonalBudget && record?.scope === 'PERSONAL' &&
      record.personalPersonId === viewerPersonId
    ) return 'personal';
    return null;
  };
  const isInMonth = (value) => {
    const civil = toCivilDate(value);
    return civil.getUTCFullYear() === year && civil.getUTCMonth() + 1 === month;
  };
  const add = (scope, cents, name) => {
    used[scope] += BigInt(nonNegativeCents(cents, name));
  };

  for (const payment of payments) {
    const scope = scopeFor(payment.recurringExpense);
    if (!scope || payment.status !== 'PAID' || !isInMonth(payment.dueDate)) continue;
    // ExpensePayment_status_shape_check and the API require an actual amount
    // for PAID. Invalid legacy data must not silently become an estimated spend.
    add(scope, payment.actualAmountCents, 'payment.actualAmountCents');
  }

  for (const variableMonth of variableMonths) {
    const scope = scopeFor(variableMonth);
    if (!scope || variableMonth.year !== year || variableMonth.month !== month) continue;
    if (variableMonth.entryMode === 'SUMMARY') {
      add(scope, variableMonth.summaryAmountCents, 'variableMonth.summaryAmountCents');
    } else if (variableMonth.entryMode === 'DETAIL') {
      // Sum real entries even before a month is marked complete; completion is
      // relevant to historical recommendations, not to already registered spend.
      for (const entry of variableMonth.entries ?? []) {
        add(scope, entry.amountCents, 'variableEntry.amountCents');
      }
    } else {
      throw new RangeError('Modo de gasto variable no soportado.');
    }
  }

  for (const invoice of invoices) {
    const scope = scopeFor(invoice);
    if (!scope || !isInMonth(invoice.chargeDate ?? invoice.invoiceDate)) continue;
    add(scope, invoice.amountCents, 'invoice.amountCents');
  }

  for (const source of purchaseSources) {
    const scope = includeViewerPurchaseHistory && hasPersonalBudget && source.scope === 'PERSONAL'
      ? 'personal' : scopeFor(source);
    if (!scope || source.status !== 'PAID' || !source.paidAt || !isInMonth(source.paidAt)) continue;
    add(scope, source.actualAmountCents, 'purchaseSource.actualAmountCents');
  }

  const common = progressFor(commonBudgetCents, used.common, 'common');
  const personal = hasPersonalBudget
    ? { personId: viewerPersonId, ...progressFor(personalBudgetCents, used.personal, 'personal') }
    : null;

  return {
    monthlyProgress: { common, personal },
    cashCoverage: {
      common: coverageFor(commonBalanceCents, common.remainingCents, 'common'),
      personal: personal && personalBalanceCents !== null
        ? {
            personId: viewerPersonId,
            ...coverageFor(personalBalanceCents, personal.remainingCents, 'personal'),
          }
        : null,
    },
  };
}
