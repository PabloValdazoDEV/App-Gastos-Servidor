const INTEGER_ERROR = 'Los importes y porcentajes deben ser enteros seguros.';

export function assertSafeInteger(value, name = 'value') {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name}: ${INTEGER_ERROR}`);
  }

  return value;
}

function toBigInt(value, name) {
  if (typeof value === 'bigint') return value;
  return BigInt(assertSafeInteger(value, name));
}

export function roundDivide(numerator, denominator) {
  const bigNumerator = toBigInt(numerator, 'numerator');
  const bigDenominator = toBigInt(denominator, 'denominator');

  if (bigDenominator <= 0n) {
    throw new RangeError('denominator debe ser mayor que cero.');
  }

  const sign = bigNumerator < 0n ? -1n : 1n;
  const absoluteNumerator = bigNumerator < 0n ? -bigNumerator : bigNumerator;
  const quotient = absoluteNumerator / bigDenominator;
  const remainder = absoluteNumerator % bigDenominator;
  const rounded = remainder * 2n >= bigDenominator ? quotient + 1n : quotient;
  const result = Number(rounded * sign);

  return assertSafeInteger(result, 'roundedResult');
}

export function ceilDivide(numerator, denominator) {
  const bigNumerator = toBigInt(numerator, 'numerator');
  const bigDenominator = toBigInt(denominator, 'denominator');

  if (bigNumerator < 0n || bigDenominator <= 0n) {
    throw new RangeError('ceilDivide exige valores no negativos y divisor positivo.');
  }

  const result = Number((bigNumerator + bigDenominator - 1n) / bigDenominator);
  return assertSafeInteger(result, 'ceilResult');
}

export function applyMarginCents(baseCents, marginBps) {
  assertSafeInteger(baseCents, 'baseCents');
  assertSafeInteger(marginBps, 'marginBps');

  if (baseCents < 0 || marginBps < 0 || marginBps > 10_000) {
    throw new RangeError('El importe debe ser positivo y el margen estar entre 0 y 10000.');
  }

  return roundDivide(BigInt(baseCents) * BigInt(10_000 + marginBps), 10_000n);
}

export function splitAmount(totalCents, participants) {
  assertSafeInteger(totalCents, 'totalCents');

  if (totalCents < 0 || !Array.isArray(participants) || participants.length === 0) {
    throw new RangeError('Se necesita un importe no negativo y al menos un participante.');
  }

  const normalized = participants.map((participant, index) => {
    const contributionBps = assertSafeInteger(
      participant.contributionBps,
      `participants[${index}].contributionBps`,
    );

    if (!participant.id || contributionBps < 0 || contributionBps > 10_000) {
      throw new RangeError('Cada participante necesita id y un porcentaje válido.');
    }

    return {
      ...participant,
      contributionBps,
      stableOrder: participant.sortOrder ?? index,
    };
  });

  const totalBps = normalized.reduce(
    (sum, participant) => sum + participant.contributionBps,
    0,
  );

  if (totalBps !== 10_000) {
    throw new RangeError('Los porcentajes activos deben sumar exactamente 100 %.');
  }

  const denominator = 10_000n;
  const allocations = normalized.map((participant) => {
    const numerator = BigInt(totalCents) * BigInt(participant.contributionBps);

    return {
      id: participant.id,
      amountCents: Number(numerator / denominator),
      remainder: numerator % denominator,
      stableOrder: participant.stableOrder,
    };
  });

  let centsLeft =
    totalCents - allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);

  const remainderOrder = [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }

    if (left.stableOrder !== right.stableOrder) {
      return left.stableOrder - right.stableOrder;
    }

    return left.id.localeCompare(right.id);
  });

  for (let index = 0; centsLeft > 0; index += 1) {
    remainderOrder[index % remainderOrder.length].amountCents += 1;
    centsLeft -= 1;
  }

  return allocations.map(({ id, amountCents }) => ({ id, amountCents }));
}

export function eurosToCents(value) {
  const normalized = String(value).trim().replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);

  if (!match) {
    throw new TypeError('Introduce un importe con un máximo de dos decimales.');
  }

  const [, sign, units, decimals = ''] = match;
  const cents = Number(BigInt(units) * 100n + BigInt(decimals.padEnd(2, '0')));
  return assertSafeInteger(sign === '-' ? -cents : cents, 'cents');
}

export function centsToEuros(cents) {
  assertSafeInteger(cents, 'cents');
  const absolute = Math.abs(cents);
  const units = Math.floor(absolute / 100);
  const decimals = String(absolute % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${units}.${decimals}`;
}

export function formatCurrency(cents, locale = 'es-ES', currency = 'EUR') {
  assertSafeInteger(cents, 'cents');
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
