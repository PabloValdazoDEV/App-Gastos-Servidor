import { createDomainError } from './domainError.js';

export const throwMappedPrismaError = (error, fallback) => {
  if (error?.code === 'P2002') {
    throw createDomainError(
      409,
      fallback?.uniqueCode ?? 'RESOURCE_ALREADY_EXISTS',
      fallback?.uniqueMessage ?? 'Ya existe un recurso con esos datos.',
    );
  }

  if (error?.code === 'P2025') {
    throw createDomainError(
      404,
      fallback?.notFoundCode ?? 'RESOURCE_NOT_FOUND',
      fallback?.notFoundMessage ?? 'No se encontró el recurso solicitado.',
    );
  }

  throw error;
};

