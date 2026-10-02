import { addCalendarMonths, differenceInCalendarDays, endOfMonth, monthKey, startOfMonth, toCivilDate } from './date.service.js';

export const VARIABLE_CLOSING_DAYS = 3;

// Include a nearly finished month only when forecasting a later month.
// This is an estimate; it never closes or changes the underlying records.
export function variableForecastWindow(calculationDate, asOfDate) {
  const target = toCivilDate(calculationDate);
  const today = toCivilDate(asOfDate);
  const daysRemaining = differenceInCalendarDays(endOfMonth(today), today);
  const eligible = startOfMonth(target) > startOfMonth(today) && daysRemaining <= VARIABLE_CLOSING_DAYS;
  return {
    historyDate: eligible ? addCalendarMonths(startOfMonth(today), 1) : target < today ? target : today,
    estimatedClosingMonth: eligible ? monthKey(today) : null,
  };
}
