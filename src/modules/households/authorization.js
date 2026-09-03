import { createDomainError } from '../household-domain/domainError.js';

export const HOUSEHOLD_ROLES = Object.freeze({
  MEMBER: 'MEMBER',
  ADMIN: 'ADMIN',
  OWNER: 'OWNER',
});

const ROLE_WEIGHT = Object.freeze({
  [HOUSEHOLD_ROLES.MEMBER]: 1,
  [HOUSEHOLD_ROLES.ADMIN]: 2,
  [HOUSEHOLD_ROLES.OWNER]: 3,
});

export const hasMinimumRole = (actualRole, minimumRole) =>
  ROLE_WEIGHT[actualRole] >= ROLE_WEIGHT[minimumRole];

export const requireHouseholdRole = async (
  database,
  {
    householdId,
    userId,
    minimumRole = HOUSEHOLD_ROLES.MEMBER,
    allowInactiveHousehold = false,
  },
) => {
  const access = await database.householdUserAccess.findFirst({
    where: {
      householdId,
      userId,
      isActive: true,
      revokedAt: null,
      ...(allowInactiveHousehold ? {} : { household: { isActive: true } }),
    },
    include: { household: true },
  });

  if (!access) {
    throw createDomainError(
      404,
      'HOUSEHOLD_NOT_FOUND',
      'No se encontró el hogar solicitado.',
    );
  }

  if (!hasMinimumRole(access.role, minimumRole)) {
    throw createDomainError(
      403,
      'HOUSEHOLD_PERMISSION_DENIED',
      'No tienes permisos para realizar esta acción en el hogar.',
      [{ minimumRole }],
    );
  }

  if (
    access.role === HOUSEHOLD_ROLES.OWNER &&
    access.household.ownerUserId !== userId
  ) {
    throw createDomainError(
      409,
      'HOUSEHOLD_OWNER_INVARIANT_BROKEN',
      'La propiedad del hogar necesita ser reparada antes de continuar.',
    );
  }

  return access;
};

export const requireHouseholdPerson = async (
  database,
  { householdId, personId, includeArchived = false },
) => {
  const person = await database.householdPerson.findFirst({
    where: {
      id: personId,
      householdId,
      ...(includeArchived ? {} : { archivedAt: null }),
    },
  });

  if (!person) {
    throw createDomainError(
      404,
      'HOUSEHOLD_PERSON_NOT_FOUND',
      'No se encontró la persona solicitada en este hogar.',
    );
  }

  return person;
};

export const requireHouseholdCategory = async (
  database,
  { householdId, categoryId, includeArchived = false },
) => {
  const category = await database.category.findFirst({
    where: {
      id: categoryId,
      householdId,
      ...(includeArchived ? {} : { archivedAt: null }),
    },
  });

  if (!category) {
    throw createDomainError(
      404,
      'CATEGORY_NOT_FOUND',
      'No se encontró la categoría solicitada en este hogar.',
    );
  }

  return category;
};

export const requireHouseholdAccessRecord = async (
  database,
  { householdId, accessId },
) => {
  const access = await database.householdUserAccess.findFirst({
    where: { id: accessId, householdId },
    include: {
      user: {
        select: { id: true, email: true, name: true, isActive: true },
      },
    },
  });

  if (!access) {
    throw createDomainError(
      404,
      'HOUSEHOLD_ACCESS_NOT_FOUND',
      'No se encontró el acceso solicitado en este hogar.',
    );
  }

  return access;
};

