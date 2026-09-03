import {
  addCalendarMonths,
  compareCivilDates,
  differenceInCalendarDays,
  toCivilDate,
  toIsoDate,
} from './date.service.js';
import {
  assertSafeInteger,
  ceilDivide,
  roundDivide,
  splitAmount,
} from './money.service.js';

const RECOMMENDED_RECOVERY_MONTHS = 12;

const PERIOD_MONTHS = Object.freeze({
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  YEARLY: 12,
});

function inferCycleStart(expense) {
  if (expense.cycleStartDate) return toCivilDate(expense.cycleStartDate);
  if (expense.frequency === 'WEEKLY') {
    const next = toCivilDate(expense.nextDueDate);
    next.setUTCDate(next.getUTCDate() - 7);
    return next;
  }
  const months =
    expense.frequency === 'CUSTOM_MONTHS'
      ? expense.intervalMonths
      : PERIOD_MONTHS[expense.frequency];
  if (months) return addCalendarMonths(expense.nextDueDate, -months);
  return toCivilDate(expense.startDate);
}

export function calculateTheoreticalReserve(expenses, simulationDate) {
  const simulated = toCivilDate(simulationDate);
  const lines = expenses
    .filter(
      (expense) =>
        expense.scope === 'HOUSEHOLD' &&
        expense.isActive !== false &&
        !expense.archivedAt &&
        expense.frequency !== 'MONTHLY' &&
        expense.frequency !== 'WEEKLY',
    )
    .map((expense) => {
      const cycleStart = inferCycleStart(expense);
      const cycleEnd = toCivilDate(expense.nextDueDate);
      const totalDays = Math.max(1, differenceInCalendarDays(cycleEnd, cycleStart));
      const elapsedDays = Math.min(
        totalDays,
        Math.max(0, differenceInCalendarDays(simulated, cycleStart)),
      );
      const reserveCents = roundDivide(
        BigInt(expense.amountCents) * BigInt(elapsedDays),
        BigInt(totalDays),
      );
      return {
        expenseId: expense.id,
        name: expense.name,
        targetAmountCents: expense.amountCents,
        cycleStart: toIsoDate(cycleStart),
        dueDate: toIsoDate(cycleEnd),
        totalDays,
        elapsedDays,
        reserveCents,
        daysRemaining: Math.max(0, differenceInCalendarDays(cycleEnd, simulated)),
        overdue: compareCivilDates(cycleEnd, simulated) < 0,
      };
    });

  return {
    simulationDate: toIsoDate(simulated),
    theoreticalReserveCents: lines.reduce((sum, line) => sum + line.reserveCents, 0),
    lines,
  };
}

export function calculateFinancialStatus({
  theoreticalReserveCents,
  relevantAvailableBalanceCents,
  upcomingPayments = [],
}) {
  const deficitCents = Math.max(
    0,
    theoreticalReserveCents - relevantAvailableBalanceCents,
  );
  const nextPayment = [...upcomingPayments]
    .filter((payment) => payment.scope === 'HOUSEHOLD')
    .sort((left, right) => compareCivilDates(left.dueDate, right.dueDate))[0];
  const paymentRisk = Boolean(
    nextPayment && nextPayment.amountCents > relevantAvailableBalanceCents,
  );

  let financialStatus = 'OK';
  if (paymentRisk) financialStatus = 'PAYMENT_RISK';
  else if (deficitCents > 0) financialStatus = 'DEFICIT';
  else if (
    BigInt(theoreticalReserveCents) * 10n >
    BigInt(relevantAvailableBalanceCents) * 9n
  ) {
    financialStatus = 'ATTENTION';
  }

  return { deficitCents, financialStatus, nextPayment: nextPayment ?? null };
}

export function calculateSimulation({
  standardBudget,
  recurringExpenses,
  simulationDate,
  relevantAvailableBalanceCents,
}) {
  const reserve = calculateTheoreticalReserve(recurringExpenses, simulationDate);
  const upcomingPayments = recurringExpenses
    .filter((expense) => expense.isActive !== false && !expense.archivedAt)
    .map((expense) => ({
      expenseId: expense.id,
      name: expense.name,
      dueDate: toIsoDate(expense.nextDueDate),
      amountCents: expense.amountCents,
      scope: expense.scope,
      daysRemaining: differenceInCalendarDays(expense.nextDueDate, simulationDate),
    }))
    .filter((expense) => expense.daysRemaining >= 0)
    .sort((left, right) => left.daysRemaining - right.daysRemaining);
  const health = calculateFinancialStatus({
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    relevantAvailableBalanceCents,
    upcomingPayments,
  });

  return {
    simulationDate: toIsoDate(simulationDate),
    monthlyStandardBudgetCents: standardBudget.householdBudgetCents,
    theoreticalReserveCents: reserve.theoreticalReserveCents,
    reserveLines: reserve.lines,
    relevantAvailableBalanceCents,
    deficitCents: health.deficitCents,
    financialStatus: health.financialStatus,
    upcomingPayments,
  };
}

function inclusiveCalendarMonths(startDate, endDate) {
  const start = toCivilDate(startDate);
  const end = toCivilDate(endDate);
  const difference =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth();

  return Math.max(1, difference + 1);
}

function recommendedRecoveryAnalysis({
  deficitCents,
  upcomingPayments,
  relevantAvailableBalanceCents,
  standardMonthlyBudgetCents,
  startsOn,
}) {
  assertSafeInteger(standardMonthlyBudgetCents, 'standardMonthlyBudgetCents');
  assertSafeInteger(
    relevantAvailableBalanceCents,
    'relevantAvailableBalanceCents',
  );
  if (standardMonthlyBudgetCents < 0) {
    throw new RangeError('standardMonthlyBudgetCents no puede ser negativo.');
  }

  const householdUpcoming = [...upcomingPayments]
    .filter((payment) => payment.scope !== 'PERSONAL')
    .filter(
      (payment) =>
        !startsOn || compareCivilDates(payment.dueDate, startsOn) >= 0,
    )
    .sort((left, right) => compareCivilDates(left.dueDate, right.dueDate));

  if (householdUpcoming.length > 0 && !startsOn) {
    throw new TypeError('RECOMMENDED necesita startsOn para evaluar vencimientos.');
  }

  let cumulativePayments = 0n;
  let cashFlowMinimumCents = 0;
  let limitingDueDate = null;
  let limitingMonthsAvailable = null;

  householdUpcoming.forEach((payment) => {
    assertSafeInteger(payment.amountCents, 'payment.amountCents');
    if (payment.amountCents < 0) {
      throw new RangeError('Los próximos pagos no pueden ser negativos.');
    }

    cumulativePayments += BigInt(payment.amountCents);
    const monthsAvailable = inclusiveCalendarMonths(startsOn, payment.dueDate);
    const availableWithoutAdjustment =
      BigInt(relevantAvailableBalanceCents) +
      BigInt(standardMonthlyBudgetCents) * BigInt(monthsAvailable);
    const shortfall = cumulativePayments - availableWithoutAdjustment;
    const requiredAdjustment =
      shortfall > 0n ? ceilDivide(shortfall, monthsAvailable) : 0;

    if (requiredAdjustment > cashFlowMinimumCents) {
      cashFlowMinimumCents = requiredAdjustment;
      limitingDueDate = toIsoDate(payment.dueDate);
      limitingMonthsAvailable = monthsAvailable;
    }
  });

  const gentleBaselineCents = ceilDivide(
    deficitCents,
    RECOMMENDED_RECOVERY_MONTHS,
  );
  const uncappedMonthlyAdjustmentCents = Math.max(
    gentleBaselineCents,
    cashFlowMinimumCents,
  );

  return {
    monthlyAdjustmentCents: Math.min(
      deficitCents,
      uncappedMonthlyAdjustmentCents,
    ),
    recommendation: {
      strategy: 'STANDARD_CONTRIBUTION_CASH_FLOW',
      standardMonthlyBudgetCents,
      gentleBaselineCents,
      cashFlowMinimumCents,
      limitingDueDate,
      limitingMonthsAvailable,
      upcomingHouseholdPayments: householdUpcoming.length,
      cappedByDeficit: uncappedMonthlyAdjustmentCents > deficitCents,
    },
  };
}

export function previewRecoveryPlan({
  deficitCents,
  mode,
  targetMonths,
  maximumMonthlyCents,
  upcomingPayments = [],
  relevantAvailableBalanceCents = 0,
  standardMonthlyBudgetCents = 0,
  startsOn,
}) {
  if (!Number.isSafeInteger(deficitCents) || deficitCents <= 0) {
    throw new RangeError('Se necesita un déficit positivo.');
  }

  let monthlyAdjustmentCents;
  let estimatedMonths;
  let recommendation;

  if (mode === 'TARGET_MONTHS') {
    if (!Number.isInteger(targetMonths) || targetMonths < 1) {
      throw new RangeError('targetMonths debe ser mayor que cero.');
    }
    estimatedMonths = targetMonths;
    monthlyAdjustmentCents = ceilDivide(deficitCents, targetMonths);
  } else if (mode === 'MAX_MONTHLY') {
    if (!Number.isSafeInteger(maximumMonthlyCents) || maximumMonthlyCents < 1) {
      throw new RangeError('maximumMonthlyCents debe ser mayor que cero.');
    }
    monthlyAdjustmentCents = Math.min(deficitCents, maximumMonthlyCents);
    estimatedMonths = ceilDivide(deficitCents, monthlyAdjustmentCents);
  } else if (mode === 'RECOMMENDED') {
    const analysis = recommendedRecoveryAnalysis({
      deficitCents,
      upcomingPayments,
      relevantAvailableBalanceCents,
      standardMonthlyBudgetCents,
      startsOn,
    });
    monthlyAdjustmentCents = analysis.monthlyAdjustmentCents;
    recommendation = analysis.recommendation;
    estimatedMonths = ceilDivide(deficitCents, monthlyAdjustmentCents);
  } else {
    throw new RangeError('Modo de recuperación no soportado.');
  }

  return {
    mode,
    deficitCents,
    targetMonths: mode === 'TARGET_MONTHS' ? targetMonths : null,
    maximumMonthlyCents: mode === 'MAX_MONTHLY' ? maximumMonthlyCents : null,
    monthlyAdjustmentCents,
    estimatedMonths,
    ...(recommendation ? { recommendation } : {}),
  };
}

export function distributeTemporaryAdjustment(adjustmentCents, people) {
  return splitAmount(adjustmentCents, people).map((share) => ({
    personId: share.id,
    temporaryAdjustmentCents: share.amountCents,
  }));
}
