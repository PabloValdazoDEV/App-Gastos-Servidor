import { describe, expect, it, vi } from 'vitest';

import { createAccessService } from '../src/modules/access/access.service.js';
import { createCategoriesService } from '../src/modules/categories/categories.service.js';
import { createInvitationsService } from '../src/modules/invitations/invitations.service.js';
import { createPeopleService } from '../src/modules/people/people.service.js';

const ids = Object.freeze({
  household: '10000000-0000-4000-8000-000000000001',
  owner: '10000000-0000-4000-8000-000000000002',
  target: '10000000-0000-4000-8000-000000000003',
  ownerAccess: '10000000-0000-4000-8000-000000000004',
  targetAccess: '10000000-0000-4000-8000-000000000005',
  invitation: '10000000-0000-4000-8000-000000000006',
  person: '10000000-0000-4000-8000-000000000007',
  category: '10000000-0000-4000-8000-000000000008',
});

const transactionPrisma = (transaction) => ({
  ...transaction,
  $transaction: vi.fn((operation) => operation(transaction)),
});

describe('household domain services', () => {
  it('transfers ownership atomically and demotes the previous owner', async () => {
    const transaction = {
      householdUserAccess: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            id: ids.ownerAccess,
            userId: ids.owner,
            role: 'OWNER',
            household: {
              id: ids.household,
              ownerUserId: ids.owner,
              isActive: true,
            },
          })
          .mockResolvedValueOnce({
            id: ids.targetAccess,
            userId: ids.target,
            role: 'MEMBER',
            user: { id: ids.target, name: 'Persona', isActive: true },
          }),
        update: vi.fn().mockResolvedValue({}),
      },
      household: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(transaction);
    const service = createAccessService({ prisma });

    const result = await service.transferOwnership({
      actorUserId: ids.owner,
      householdId: ids.household,
      newOwnerUserId: ids.target,
    });

    expect(result.ownerUserId).toBe(ids.target);
    expect(transaction.household.updateMany).toHaveBeenCalledWith({
      where: {
        id: ids.household,
        ownerUserId: ids.owner,
        isActive: true,
      },
      data: { ownerUserId: ids.target },
    });
    expect(transaction.householdUserAccess.update).toHaveBeenNthCalledWith(
      1,
      { where: { id: ids.ownerAccess }, data: { role: 'ADMIN' } },
    );
    expect(transaction.householdUserAccess.update).toHaveBeenNthCalledWith(
      2,
      { where: { id: ids.targetAccess }, data: { role: 'OWNER' } },
    );
  });

  it('stores only an invitation token hash and returns the raw token once', async () => {
    const fixedDate = new Date('2026-08-26T12:00:00.000Z');
    const rawToken = 'secure-token-that-is-returned-only-once-1234567890';
    const transaction = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          id: ids.ownerAccess,
          role: 'OWNER',
          household: { ownerUserId: ids.owner },
        }),
        findUnique: vi.fn(),
      },
      householdPerson: { findFirst: vi.fn() },
      invitation: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: ids.invitation,
            householdId: ids.household,
            householdPersonId: null,
            email: data.email,
            role: data.role,
            status: 'PENDING',
            expiresAt: data.expiresAt,
            createdAt: fixedDate,
          }),
        ),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(transaction);
    const service = createInvitationsService({
      prisma,
      now: () => fixedDate,
      tokenFactory: () => rawToken,
    });

    const result = await service.create({
      actorUserId: ids.owner,
      householdId: ids.household,
      input: { email: 'persona@example.com', role: 'MEMBER' },
    });

    const createData = transaction.invitation.create.mock.calls[0][0].data;
    expect(result.token).toBe(rawToken);
    expect(createData.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createData.tokenHash).not.toBe(rawToken);
    expect(transaction.auditLog.create.mock.calls[0][0]).not.toContain(
      rawToken,
    );
  });

  it('rejects invitation acceptance by a different email before writing', async () => {
    const fixedDate = new Date('2026-08-26T12:00:00.000Z');
    const transaction = {
      invitation: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.invitation,
          householdId: ids.household,
          email: 'destino@example.com',
          role: 'MEMBER',
          status: 'PENDING',
          expiresAt: new Date('2026-08-27T12:00:00.000Z'),
          household: {
            id: ids.household,
            name: 'Casa',
            isActive: true,
            ownerUserId: ids.owner,
          },
          householdPerson: null,
        }),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.target,
          email: 'otra@example.com',
          isActive: true,
        }),
      },
    };
    const prisma = transactionPrisma(transaction);
    const service = createInvitationsService({
      prisma,
      now: () => fixedDate,
    });

    await expect(
      service.accept({ actorUserId: ids.target, token: 'a'.repeat(43) }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'INVITATION_EMAIL_MISMATCH',
    });
    expect(transaction.invitation.updateMany).not.toHaveBeenCalled();
  });

  it('rejects distribution IDs that belong to another household', async () => {
    const transaction = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          role: 'ADMIN',
          household: {
            id: ids.household,
            ownerUserId: ids.owner,
            contributionMode: 'PERCENTAGE',
          },
        }),
      },
      householdPerson: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
    };
    const prisma = transactionPrisma(transaction);
    const service = createPeopleService({ prisma });

    await expect(
      service.updateDistribution({
        actorUserId: ids.owner,
        householdId: ids.household,
        input: {
          people: [{ personId: ids.person, contributionBps: 10000 }],
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'HOUSEHOLD_PERSON_NOT_FOUND',
    });
    expect(transaction.householdPerson.update).not.toHaveBeenCalled();
  });

  it('refuses physical category deletion when financial history exists', async () => {
    const transaction = {
      householdUserAccess: {
        findFirst: vi.fn().mockResolvedValue({
          role: 'OWNER',
          household: { id: ids.household, ownerUserId: ids.owner },
        }),
      },
      category: {
        findFirst: vi.fn().mockResolvedValue({
          id: ids.category,
          householdId: ids.household,
        }),
        delete: vi.fn(),
      },
      recurringExpense: { count: vi.fn().mockResolvedValue(1) },
      utilityInvoice: { count: vi.fn().mockResolvedValue(0) },
      variableExpenseMonth: { count: vi.fn().mockResolvedValue(0) },
    };
    const prisma = transactionPrisma(transaction);
    const service = createCategoriesService({ prisma });

    await expect(
      service.remove({
        actorUserId: ids.owner,
        householdId: ids.household,
        categoryId: ids.category,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATEGORY_HAS_DEPENDENCIES',
    });
    expect(transaction.category.delete).not.toHaveBeenCalled();
  });
});

