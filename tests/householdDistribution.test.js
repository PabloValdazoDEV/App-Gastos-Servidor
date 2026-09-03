import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors/AppError.js';
import {
  CONTRIBUTION_MODES,
  validateContributionDistribution,
} from '../src/modules/households/distribution.js';

const person = (overrides = {}) => ({
  id: crypto.randomUUID(),
  contributionBps: 0,
  fixedContributionCents: null,
  isActive: true,
  archivedAt: null,
  ...overrides,
});

describe('household contribution distribution', () => {
  it('accepts active percentages that add up to exactly 100 percent', () => {
    const result = validateContributionDistribution(
      CONTRIBUTION_MODES.PERCENTAGE,
      [person({ contributionBps: 6000 }), person({ contributionBps: 4000 })],
    );

    expect(result).toMatchObject({
      activePeople: 2,
      totalContributionBps: 10000,
    });
  });

  it('rejects percentage distributions below or above 100 percent', () => {
    expect(() =>
      validateContributionDistribution(CONTRIBUTION_MODES.PERCENTAGE, [
        person({ contributionBps: 5000 }),
        person({ contributionBps: 4999 }),
      ]),
    ).toThrowError(AppError);

    try {
      validateContributionDistribution(CONTRIBUTION_MODES.PERCENTAGE, [
        person({ contributionBps: 7500 }),
        person({ contributionBps: 5000 }),
      ]);
    } catch (error) {
      expect(error.code).toBe('INVALID_CONTRIBUTION_DISTRIBUTION');
      expect(error.statusCode).toBe(409);
    }
  });

  it('ignores inactive and archived people when validating percentages', () => {
    const result = validateContributionDistribution(
      CONTRIBUTION_MODES.PERCENTAGE,
      [
        person({ contributionBps: 10000 }),
        person({ contributionBps: 9000, isActive: false }),
        person({ contributionBps: 9000, archivedAt: new Date() }),
      ],
    );

    expect(result.activePeople).toBe(1);
    expect(result.totalContributionBps).toBe(10000);
  });

  it('supports fixed contributions without requiring a percentage total', () => {
    const result = validateContributionDistribution(CONTRIBUTION_MODES.FIXED, [
      person({ fixedContributionCents: 45000 }),
      person({ fixedContributionCents: 62500 }),
    ]);

    expect(result.totalFixedContributionCents).toBe(107500);
  });

  it('requires every active person to have a fixed amount in fixed mode', () => {
    expect(() =>
      validateContributionDistribution(CONTRIBUTION_MODES.FIXED, [person()]),
    ).toThrowError(/aportación fija/);
  });

  it('allows a household with no active economic people', () => {
    expect(
      validateContributionDistribution(CONTRIBUTION_MODES.PERCENTAGE, []),
    ).toEqual({
      mode: 'PERCENTAGE',
      activePeople: 0,
      totalContributionBps: 0,
      totalFixedContributionCents: 0,
    });
  });
});

