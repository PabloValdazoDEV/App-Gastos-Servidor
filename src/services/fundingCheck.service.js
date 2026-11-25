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
      cycleDays: line.totalDays,
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

export const RECOVERY_MONTH_OPTIONS = Object.freeze([2, 3, 6]);
const AVERAGE_MONTH_DAYS = 30.4375;
const HORIZON_MONTHS = 12;
// Cent rounding of the month-by-month model must not flag a payment as at risk.
const TOLERANCE_CENTS = 100;

const monthIndex = (date) => {
  const civil = toCivilDate(date);
  return civil.getUTCFullYear() * 12 + civil.getUTCMonth();
};

/*
 * Can the shortfall be spread over N months without leaving a payment unpaid?
 * Month by month for the next year, the joint account starts with the savings
 * it should have minus the shortfall, receives each month the provision for
 * the big charges (inside the normal contribution) plus 1/N of the shortfall,
 * and pays each big charge on its due month. Any month below zero puts that
 * payment at risk. Month 0 also covers this month's own payments.
 */
export function recoveryOptions(basis, { shortfallCents, calculationDate, months = RECOVERY_MONTH_OPTIONS }) {
  if (!shortfallCents || shortfallCents <= 0) return [];
  const startMonth = monthIndex(startOfMonth(toCivilDate(calculationDate)));
  const lines = (basis.reserveForLaterLines ?? []).map((line) => {
    const cycleMonths = Math.max(2, Math.round((line.cycleDays ?? 365) / AVERAGE_MONTH_DAYS));
    return {
      name: line.name,
      dueDate: line.dueDate,
      amountCents: line.targetAmountCents,
      firstDueMonth: monthIndex(line.dueDate) - startMonth,
      cycleMonths,
      monthlyProvisionCents: line.targetAmountCents / cycleMonths,
    };
  });
  const monthlyProvisionCents = lines.reduce((sum, line) => sum + line.monthlyProvisionCents, 0);

  return months.map((count) => {
    const installmentCents = shortfallCents / count;
    let cashCents = basis.reserveForLaterCents - shortfallCents + installmentCents;
    let risk = cashCents < -TOLERANCE_CENTS ? { name: 'Los pagos de este mes', dueDate: null } : null;
    for (let month = 1; month <= HORIZON_MONTHS && !risk; month += 1) {
      cashCents += monthlyProvisionCents + (month < count ? installmentCents : 0);
      for (const line of lines) {
        const sinceFirst = month - line.firstDueMonth;
        if (sinceFirst < 0 || sinceFirst % line.cycleMonths !== 0) continue;
        cashCents -= line.amountCents;
        if (cashCents < -TOLERANCE_CENTS && !risk) {
          const due = toCivilDate(line.dueDate);
          due.setUTCMonth(due.getUTCMonth() + sinceFirst);
          risk = { name: line.name, dueDate: due.toISOString().slice(0, 10) };
        }
      }
    }
    return { months: count, monthlyCents: Math.ceil(shortfallCents / count), safe: !risk, risk };
  });
}
