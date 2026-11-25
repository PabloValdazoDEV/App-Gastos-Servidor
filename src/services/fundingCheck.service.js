import { compareCivilDates, endOfMonth, startOfMonth, toCivilDate } from './date.service.js';

/*
 * "Preparar el mes": what the joint account needs this month versus what it
 * will have. Each euro is counted once:
 * - pendingThisMonthCents: joint payments of this month still unpaid
 *   (an annual charge due this month is here, not in the reserve);
 * - overdueCents: joint recurring occurrences from earlier months still unpaid;
 * - reserveForLaterCents: savings that should already exist for charges due
 *   after this month (insurance, yearly fees…).
 * The planned contribution is added to the balance only when it has not been
 * transferred yet, so a balance typed before contributing is not a deficit.
 */
export function buildFundingBasis({
  calculationDate,
  pendingThisMonthCents,
  reserveLines = [],
  recurringExpenses = [],
  pendingDueDatesFor,
  plannedContributionCents,
  contributions = [],
}) {
  const monthStart = startOfMonth(toCivilDate(calculationDate));
  const monthEnd = endOfMonth(monthStart);
  const reserveForLater = reserveLines.filter(
    (line) => !line.overdue && compareCivilDates(line.dueDate, monthEnd) > 0,
  );
  const overdueCents = recurringExpenses
    .filter((expense) => expense.scope === 'HOUSEHOLD' && expense.isActive !== false && !expense.archivedAt)
    .reduce((sum, expense) => {
      const before = pendingDueDatesFor(expense, monthStart)
        .filter((dueDate) => compareCivilDates(dueDate, monthStart) < 0);
      return sum + before.length * expense.amountCents;
    }, 0);
  return {
    pendingThisMonthCents: Math.max(0, pendingThisMonthCents ?? 0),
    overdueCents,
    reserveForLaterCents: reserveForLater.reduce((sum, line) => sum + line.reserveCents, 0),
    reserveForLaterLines: reserveForLater.map((line) => ({
      expenseId: line.expenseId, name: line.name, dueDate: line.dueDate,
      reserveCents: line.reserveCents, targetAmountCents: line.targetAmountCents,
    })),
    plannedContributionCents: Math.max(0, plannedContributionCents ?? 0),
    contributions: contributions.map((item) => ({
      personId: item.personId, personName: item.personName, contributionBps: item.contributionBps,
    })),
  };
}

export function calculateFundingShortfall(basis, { balanceCents, contributionDone }) {
  if (!Number.isSafeInteger(balanceCents)) throw new RangeError('balanceCents debe ser un entero.');
  const pendingContributionCents = contributionDone ? 0 : basis.plannedContributionCents;
  const availableCents = balanceCents + pendingContributionCents;
  const neededCents = basis.pendingThisMonthCents + basis.overdueCents + basis.reserveForLaterCents;
  return {
    balanceCents,
    pendingContributionCents,
    availableCents,
    neededCents,
    shortfallCents: Math.max(0, neededCents - availableCents),
    surplusCents: Math.max(0, availableCents - neededCents),
  };
}
