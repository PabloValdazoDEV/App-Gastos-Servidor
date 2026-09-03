const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function toCivilDate(value, name = 'date') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${name} debe usar el formato YYYY-MM-DD.`);
  }

  const match = ISO_DATE.exec(value);
  if (!match) throw new TypeError(`${name} debe usar el formato YYYY-MM-DD.`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`${name} no es una fecha válida.`);
  }

  return date;
}

export function toIsoDate(value) {
  return toCivilDate(value).toISOString().slice(0, 10);
}

export function differenceInCalendarDays(later, earlier) {
  return Math.round((toCivilDate(later).getTime() - toCivilDate(earlier).getTime()) / DAY_MS);
}

export function inclusivePeriodDays(start, end) {
  const difference = differenceInCalendarDays(end, start);
  if (difference < 0) throw new RangeError('La fecha final no puede ser anterior a la inicial.');
  return difference + 1;
}

export function addCalendarDays(value, days) {
  if (!Number.isInteger(days)) throw new TypeError('days debe ser entero.');
  const date = toCivilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function addCalendarMonths(value, months) {
  if (!Number.isInteger(months)) throw new TypeError('months debe ser entero.');
  const date = toCivilDate(value);
  const originalDay = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(originalDay, lastDay));
  return target;
}

export function startOfMonth(value) {
  const date = toCivilDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfMonth(value) {
  const date = toCivilDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function monthKey(value) {
  return toIsoDate(value).slice(0, 7);
}

export function compareCivilDates(left, right) {
  return Math.sign(toCivilDate(left).getTime() - toCivilDate(right).getTime());
}
