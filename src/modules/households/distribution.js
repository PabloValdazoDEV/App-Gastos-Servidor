import { createDomainError } from '../household-domain/domainError.js';

export const CONTRIBUTION_MODES = Object.freeze({
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
});

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

