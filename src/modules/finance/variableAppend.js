import { compareCivilDates, endOfMonth } from '../../services/date.service.js';

function firstDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month - 1, 1));
}

function dateInsideMonth(date, year, month) {
  if (!date) return false;
  const start = firstDayOfMonth(year, month);
  return compareCivilDates(date, start) >= 0 && compareCivilDates(date, endOfMonth(start)) <= 0;
}

/*
 * Entries to create when appending to an existing month. Pure, so the
 * merge rules can be tested without a database:
 * - a SUMMARY month keeps its previous total as one entry ("Total anterior");
 * - a new SUMMARY amount becomes one entry dated on its payment date when it
 *   falls inside the month, otherwise on day 1;
 * - DETAIL entries are added as they come.
 */
export function buildAppendedEntries(existing, body) {
  const { year, month } = existing;
  const entries = [];

  if (existing.entryMode === 'SUMMARY' && existing.summaryAmountCents > 0) {
    entries.push({
      spentOn: firstDayOfMonth(year, month),
      merchant: null,
      amountCents: existing.summaryAmountCents,
      notes: 'Total anterior',
      paidAt: existing.paidAt ?? null,
    });
  }

  if (body.entryMode === 'SUMMARY') {
    if (body.summaryAmountCents > 0) {
      entries.push({
        spentOn: dateInsideMonth(body.paymentDate, year, month)
          ? body.paymentDate
          : firstDayOfMonth(year, month),
        merchant: null,
        amountCents: body.summaryAmountCents,
        notes: body.notes ?? null,
        paidAt: body.paymentDate ?? null,
      });
    }
  } else {
    (body.entries ?? []).forEach((entry) => {
      entries.push({
        spentOn: entry.spentOn,
        merchant: entry.merchant ?? null,
        amountCents: entry.amountCents,
        notes: entry.notes ?? null,
        paidAt: entry.paymentDate ?? null,
      });
    });
  }

  return entries;
}

export async function appendToVariableMonth(database, existing, body) {
  const entries = buildAppendedEntries(existing, body);
  // Switch to DETAIL before inserting: PostgreSQL rejects entries on a
  // SUMMARY month. Existing DETAIL entries are left untouched.
  const month = existing.entryMode === 'DETAIL'
    ? existing
    : await database.variableExpenseMonth.update({
        where: { id: existing.id },
        data: { entryMode: 'DETAIL', summaryAmountCents: null, paidAt: null },
      });
  if (entries.length) {
    await database.variableExpenseEntry.createMany({
      data: entries.map((entry) => ({ variableExpenseMonthId: month.id, ...entry })),
    });
  }
  return month;
}
