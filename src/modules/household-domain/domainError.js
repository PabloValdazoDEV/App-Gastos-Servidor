import { AppError } from '../../errors/AppError.js';

export const createDomainError = (
  statusCode,
  code,
  message,
  details,
) =>
  new AppError({
    statusCode,
    code,
    message,
    details,
  });

export const assertDomain = (
  condition,
  statusCode,
  code,
  message,
  details,
) => {
  if (!condition) {
    throw createDomainError(statusCode, code, message, details);
  }
};

