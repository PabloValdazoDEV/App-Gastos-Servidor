import { describe, expect, it, vi } from 'vitest';

import {
  HOUSEHOLD_ROLES,
  hasMinimumRole,
  requireHouseholdPerson,
  requireHouseholdRole,
} from '../src/modules/households/authorization.js';

const householdId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';

describe('household authorization', () => {
  it('uses the expected role hierarchy', () => {
    expect(hasMinimumRole('OWNER', 'ADMIN')).toBe(true);
    expect(hasMinimumRole('ADMIN', 'MEMBER')).toBe(true);
    expect(hasMinimumRole('MEMBER', 'ADMIN')).toBe(false);
  });

  it('returns an active access with the minimum role', async () => {
    const access = {
      id: crypto.randomUUID(),
      role: HOUSEHOLD_ROLES.ADMIN,
      household: { id: householdId, ownerUserId: crypto.randomUUID() },
    };
    const database = {
      householdUserAccess: { findFirst: vi.fn().mockResolvedValue(access) },
    };

    await expect(
      requireHouseholdRole(database, {
        householdId,
        userId,
        minimumRole: HOUSEHOLD_ROLES.ADMIN,
      }),
    ).resolves.toBe(access);
    expect(database.householdUserAccess.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          householdId,
          userId,
          isActive: true,
          revokedAt: null,
          household: { isActive: true },
        }),
      }),
    );
  });

  it('does not reveal whether an inaccessible household exists', async () => {
    const database = {
      householdUserAccess: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    await expect(
      requireHouseholdRole(database, { householdId, userId }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'HOUSEHOLD_NOT_FOUND',
    });
  });

  it('rejects a member performing an administrator action', async () => {
    const database = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          role: HOUSEHOLD_ROLES.MEMBER,
          household: { ownerUserId: crypto.randomUUID() },
        }),
      },
    };

    await expect(
      requireHouseholdRole(database, {
        householdId,
        userId,
        minimumRole: HOUSEHOLD_ROLES.ADMIN,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'HOUSEHOLD_PERMISSION_DENIED',
    });
  });

  it('always constrains child lookups by household', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const database = { householdPerson: { findFirst } };
    const personId = crypto.randomUUID();

    await expect(
      requireHouseholdPerson(database, { householdId, personId }),
    ).rejects.toMatchObject({ code: 'HOUSEHOLD_PERSON_NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: personId, householdId, archivedAt: null },
    });
  });
});

