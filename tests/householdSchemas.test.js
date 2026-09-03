import { describe, expect, it } from 'vitest';

import { createCategoryBodySchema } from '../src/modules/categories/category.schemas.js';
import { createCategorySlug } from '../src/modules/categories/categorySlug.js';
import { createHouseholdBodySchema } from '../src/modules/households/household.schemas.js';
import { createInvitationBodySchema } from '../src/modules/invitations/invitation.schemas.js';
import { updateDistributionBodySchema } from '../src/modules/people/people.schemas.js';

describe('household domain schemas', () => {
  it('normalizes category slugs and colors', () => {
    expect(createCategorySlug('  Educación y Salud  ')).toBe(
      'educacion-y-salud',
    );
    expect(
      createCategoryBodySchema.parse({
        name: 'Educación',
        icon: 'GraduationCap',
        color: '#a1b2c3',
      }).color,
    ).toBe('#A1B2C3');
  });

  it('normalizes emails and rejects duplicate initial people', () => {
    const duplicateInput = {
      name: 'Casa',
      people: [
        { name: 'A', email: 'PERSONA@example.com', contributionBps: 5000 },
        { name: 'B', email: 'persona@example.com', contributionBps: 5000 },
      ],
    };

    expect(() => createHouseholdBodySchema.parse(duplicateInput)).toThrow();
  });

  it('requires an invitation destination and forbids OWNER invitations', () => {
    expect(() => createInvitationBodySchema.parse({})).toThrow();
    expect(() =>
      createInvitationBodySchema.parse({
        email: 'persona@example.com',
        role: 'OWNER',
      }),
    ).toThrow();
  });

  it('rejects duplicate people in an atomic distribution update', () => {
    const personId = crypto.randomUUID();

    expect(() =>
      updateDistributionBodySchema.parse({
        people: [
          { personId, contributionBps: 5000 },
          { personId, contributionBps: 5000 },
        ],
      }),
    ).toThrow();
  });
});

