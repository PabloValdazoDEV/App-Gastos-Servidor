import { createDomainError } from '../household-domain/domainError.js';

export const CONTRIBUTION_MODES = Object.freeze({
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
  // Split in proportion to each person's gross annual income.
  INCOME: 'INCOME',
});

const isActivePerson = (person) => person.isActive && person.archivedAt === null;

/*
 * Percentages (basis points) proportional to gross annual income, summing
 * exactly 100 %: largest remainder, ties by list order. People who do not
 * take part get 0. Returns null when no active person has a valid income.
 */
export const incomeShareBps = (people) => {
  const active = people.filter(isActivePerson);
  if (active.some((person) => !Number.isInteger(person.annualGrossIncomeCents) || person.annualGrossIncomeCents < 0)) {
    return null;
  }
  const total = active.reduce((sum, person) => sum + BigInt(person.annualGrossIncomeCents), 0n);
  if (total === 0n) return null;
  const shares = active.map((person, index) => {
    const numerator = BigInt(person.annualGrossIncomeCents) * 10000n;
    return { id: person.id, index, bps: Number(numerator / total), remainder: numerator % total };
  });
  let missing = 10000 - shares.reduce((sum, share) => sum + share.bps, 0);
  [...shares]
    .sort((left, right) => (right.remainder > left.remainder ? 1 : right.remainder < left.remainder ? -1 : left.index - right.index))
    .forEach((share) => {
      if (missing > 0) {
        share.bps += 1;
        missing -= 1;
      }
    });
  const byId = new Map(shares.map((share) => [share.id, share.bps]));
  return new Map(people.map((person) => [person.id, byId.get(person.id) ?? 0]));
};

const invalidDistribution = (message, details) =>
  createDomainError(
    409,
    'INVALID_CONTRIBUTION_DISTRIBUTION',
    message,
    details,
  );

export const validateContributionDistribution = (mode, people) => {
  const activePeople = people.filter(
    (person) => person.isActive && person.archivedAt === null,
  );

  if (activePeople.length === 0) {
    return {
      mode,
      activePeople: 0,
      totalContributionBps: 0,
      totalFixedContributionCents: 0,
    };
  }

  if (mode === CONTRIBUTION_MODES.PERCENTAGE) {
    const invalidPerson = activePeople.find(
      (person) =>
        !Number.isInteger(person.contributionBps) ||
        person.contributionBps < 0 ||
        person.contributionBps > 10000,
    );

    if (invalidPerson) {
      throw invalidDistribution(
        'Cada porcentaje activo debe estar entre 0 % y 100 %.',
        [{ field: 'contributionBps', personId: invalidPerson.id }],
      );
    }

    const totalContributionBps = activePeople.reduce(
      (total, person) => total + person.contributionBps,
      0,
    );

    if (totalContributionBps !== 10000) {
      throw invalidDistribution(
        'Los porcentajes de las personas activas deben sumar exactamente 100 %.',
        [
          {
            field: 'contributionBps',
            expectedBps: 10000,
            actualBps: totalContributionBps,
          },
        ],
      );
    }

    return {
      mode,
      activePeople: activePeople.length,
      totalContributionBps,
      totalFixedContributionCents: 0,
    };
  }

  if (mode === CONTRIBUTION_MODES.INCOME) {
    const invalidPerson = activePeople.find(
      (person) => !Number.isInteger(person.annualGrossIncomeCents) || person.annualGrossIncomeCents < 0,
    );
    if (invalidPerson) {
      throw invalidDistribution(
        'Indica el sueldo bruto anual de cada persona que participa.',
        [{ field: 'annualGrossIncomeCents', personId: invalidPerson.id }],
      );
    }
    if (!incomeShareBps(people)) {
      throw invalidDistribution(
        'La suma de los sueldos brutos anuales tiene que ser mayor que cero.',
        [{ field: 'annualGrossIncomeCents' }],
      );
    }
    const totalContributionBps = activePeople.reduce((total, person) => total + person.contributionBps, 0);
    return { mode, activePeople: activePeople.length, totalContributionBps, totalFixedContributionCents: 0 };
  }

  if (mode === CONTRIBUTION_MODES.FIXED) {
    const invalidPerson = activePeople.find(
      (person) =>
        !Number.isInteger(person.fixedContributionCents) ||
        person.fixedContributionCents < 0,
    );

    if (invalidPerson) {
      throw invalidDistribution(
        'Cada persona activa necesita una aportación fija no negativa.',
        [{ field: 'fixedContributionCents', personId: invalidPerson.id }],
      );
    }

    const totalFixedContributionCents = activePeople.reduce(
      (total, person) => total + person.fixedContributionCents,
      0,
    );

    return {
      mode,
      activePeople: activePeople.length,
      totalContributionBps: 0,
      totalFixedContributionCents,
    };
  }

  throw new TypeError(`Unsupported contribution mode: ${mode}`);
};

