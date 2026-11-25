import { describe, expect, it, vi } from 'vitest';

import { CONTRIBUTION_MODES, incomeShareBps, validateContributionDistribution } from '../src/modules/households/distribution.js';
import { createPeopleService } from '../src/modules/people/people.service.js';

const household = '50000000-0000-4000-8000-000000000001';
const owner = '50000000-0000-4000-8000-000000000002';
const ana = '50000000-0000-4000-8000-000000000003';
const luis = '50000000-0000-4000-8000-000000000004';
const person = (id, overrides = {}) => ({ id, name: id === ana ? 'Ana' : 'Luis', contributionBps: 5000, fixedContributionCents: null,
  annualGrossIncomeCents: null, isActive: true, archivedAt: null, ...overrides });

describe('reparto según el sueldo bruto anual', () => {
  it('reparte en proporción a lo que gana cada uno y siempre suma 100 %', () => {
    const shares = incomeShareBps([person(ana, { annualGrossIncomeCents: 3_000_000 }), person(luis, { annualGrossIncomeCents: 2_000_000 })]);
    expect([...shares.values()]).toEqual([6000, 4000]);
    const thirds = incomeShareBps([
      person('a', { annualGrossIncomeCents: 100 }), person('b', { annualGrossIncomeCents: 100 }), person('c', { annualGrossIncomeCents: 100 }),
    ]);
    expect([...thirds.values()]).toEqual([3334, 3333, 3333]);
  });

  it('quien no participa queda al 0 % y no cuenta su sueldo', () => {
    const shares = incomeShareBps([
      person(ana, { annualGrossIncomeCents: 3_000_000 }),
      person(luis, { annualGrossIncomeCents: 9_000_000, isActive: false }),
    ]);
    expect(shares.get(ana)).toBe(10000);
    expect(shares.get(luis)).toBe(0);
  });

  it('pide el sueldo de cada persona activa y que la suma sea mayor que cero', () => {
    expect(() => validateContributionDistribution(CONTRIBUTION_MODES.INCOME, [person(ana, { annualGrossIncomeCents: 3_000_000 }), person(luis)]))
      .toThrow(/sueldo bruto anual de cada persona/);
    expect(() => validateContributionDistribution(CONTRIBUTION_MODES.INCOME, [person(ana, { annualGrossIncomeCents: 0 }), person(luis, { annualGrossIncomeCents: 0 })]))
      .toThrow(/mayor que cero/);
  });

  function fakePrisma(role = 'OWNER') {
    const state = {
      household: { id: household, ownerUserId: owner, contributionMode: 'PERCENTAGE', isActive: true },
      people: [person(ana), person(luis)],
    };
    const tx = {
      householdUserAccess: { findFirst: vi.fn(async () => ({ role, household: state.household })) },
      householdPerson: {
        findMany: vi.fn(async ({ where, select }) => {
          const rows = state.people.filter((item) => !where.id?.in || where.id.in.includes(item.id));
          return select ? rows.map((item) => Object.fromEntries(Object.keys(select).map((key) => [key, item[key]]))) : rows.map((item) => ({ ...item }));
        }),
        update: vi.fn(async ({ where, data }) => Object.assign(state.people.find((item) => item.id === where.id), data)),
      },
      household: { update: vi.fn(async ({ data }) => Object.assign(state.household, data)) },
      auditLog: { create: vi.fn() },
    };
    return { state, prisma: { ...tx, $transaction: vi.fn((operation) => operation(tx)) } };
  }

  it('al guardar el reparto por sueldo calcula y guarda los porcentajes', async () => {
    const { state, prisma } = fakePrisma();
    const result = await createPeopleService({ prisma }).updateDistribution({
      actorUserId: owner, householdId: household,
      input: { contributionMode: 'INCOME', people: [
        { personId: ana, isActive: true, annualGrossIncomeCents: 3_000_000 },
        { personId: luis, isActive: true, annualGrossIncomeCents: 2_000_000 },
      ] },
    });
    expect(result.contributionMode).toBe('INCOME');
    expect(state.household.contributionMode).toBe('INCOME');
    expect(state.people.map((item) => item.contributionBps)).toEqual([6000, 4000]);
  });

  it('solo propietarios y administradores ven los sueldos', async () => {
    const { state, prisma } = fakePrisma('MEMBER');
    state.people[0].annualGrossIncomeCents = 3_000_000;
    const listed = await createPeopleService({ prisma }).list({ actorUserId: owner, householdId: household });
    expect(listed.people[0]).not.toHaveProperty('annualGrossIncomeCents');
    expect(listed.people[0].contributionBps).toBe(5000);
  });
});
