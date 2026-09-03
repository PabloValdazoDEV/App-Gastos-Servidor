import { createDomainError } from './domainError.js';

export const getAuthenticatedUserId = (request) => {
  const userId = request.auth?.userId ?? request.user?.id;

  if (!userId) {
    throw createDomainError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Necesitas iniciar sesión para continuar.',
    );
  }

  return userId;
};

export const requireAuthenticationContext = (request, _response, next) => {
  try {
    getAuthenticatedUserId(request);
    next();
  } catch (error) {
    next(error);
  }
};

