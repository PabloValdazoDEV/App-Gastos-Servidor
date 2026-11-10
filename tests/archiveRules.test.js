import { describe, expect, it, vi } from 'vitest';

import { createCategoriesService } from '../src/modules/categories/categories.service.js';
import { createPeopleService } from '../src/modules/people/people.service.js';

const ids = Object.freeze({
  household: '40000000-0000-4000-8000-000000000001',
  owner: '40000000-0000-4000-8000-000000000002',
  category: '40000000-0000-4000-8000-000000000003',
  person: '40000000-0000-4000-8000-000000000004',
});

const transactionPrisma = (transaction) => ({
  ...transaction,
  $transaction: vi.fn((operation) => operation(transaction)),
});

const ownerAccess = () => ({
  findFirst: vi.fn().mockResolvedValue({
    role: 'OWNER',
    household: { id: ids.household, ownerUserId: ids.owner, isActive: true, timezone: 'Europe/Madrid' },
  }),
});

describe('restaurar una categoría archivada', () => {
  it('quita el archivado y lo deja en el registro de auditoría', async () => {
    const transaction = {
      householdUserAccess: ownerAccess(),
      category: {
        findFirst: vi.fn().mockResolvedValue({ id: ids.category, householdId: ids.household, archivedAt: new Date('2026-10-01') }),
        update: vi.fn().mockResolvedValue({ id: ids.category, archivedAt: null }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = createCategoriesService({ prisma: transactionPrisma(transaction) });

    const category = await service.restore({ actorUserId: ids.owner, householdId: ids.household, categoryId: ids.category });

    expect(category.archivedAt).toBeNull();
    expect(transaction.category.update).toHaveBeenCalledWith({ where: { id: ids.category }, data: { archivedAt: null } });
    expect(transaction.auditLog.create).toHaveBeenCalled();
  });
});

describe('archivar una persona con gastos a su nombre', () => {
  function fixture(counts = {}) {
    const count = (value = 0) => ({ count: vi.fn().mockResolvedValue(value) });
    const transaction = {
      householdUserAccess: ownerAccess(),
      householdPerson: {
        findFirst: vi.fn().mockResolvedValue({ id: ids.person, householdId: ids.household, name: 'Ana', isActive: true, archivedAt: null }),
        update: vi.fn().mockResolvedValue({ id: ids.person }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      recurringExpense: count(counts.recurring),
      purchase: count(counts.purchases),
      oneTimeExpense: count(counts.oneTime),
      variableExpenseMonth: count(counts.variable),
      utilityInvoice: count(counts.invoices),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    return { transaction, service: createPeopleService({ prisma: transactionPrisma(transaction) }) };
  }

  it('lo impide si tiene una compra a plazos pendiente y explica qué hacer', async () => {
    const { transaction, service } = fixture({ purchases: 1 });

    await expect(service.archive({ actorUserId: ids.owner, householdId: ids.household, personId: ids.person }))
      .rejects.toMatchObject({ statusCode: 409, code: 'HOUSEHOLD_PERSON_HAS_ACTIVE_EXPENSES', message: expect.stringMatching(/1 compra con pagos pendientes/) });
    expect(transaction.householdPerson.update).not.toHaveBeenCalled();
  });

  it('lista todo lo pendiente en un solo mensaje', async () => {
    const { service } = fixture({ recurring: 2, oneTime: 1, invoices: 3 });

    await expect(service.archive({ actorUserId: ids.owner, householdId: ids.household, personId: ids.person }))
      .rejects.toMatchObject({ message: expect.stringMatching(/2 gastos recurrentes activos, 1 gasto puntual de hoy o posterior, 3 facturas del mes actual o posteriores/) });
  });
});
