import { rateLimit } from 'express-rate-limit';

import { AppError } from '../errors/AppError.js';
import { sha256 } from '../utils/crypto.js';

export const createGeneralRateLimiter = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(_request, _response, next) {
      next(
        new AppError({
          statusCode: 429,
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Se han realizado demasiadas solicitudes. Inténtalo de nuevo más tarde.',
        }),
      );
    },
  });

export const createAuthRateLimiter = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(_request, _response, next) {
      next(
        new AppError({
          statusCode: 429,
          code: 'AUTH_RATE_LIMIT_EXCEEDED',
          message:
            'Se han realizado demasiados intentos. Inténtalo de nuevo más tarde.',
        }),
      );
    },
  });

export const createAuthAccountRateLimiter = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator(request) {
      const email =
        typeof request.body?.email === 'string'
          ? request.body.email.trim().toLowerCase()
          : null;

      return email ? sha256(email) : 'missing-email';
    },
    handler(_request, _response, next) {
      next(
        new AppError({
          statusCode: 429,
          code: 'AUTH_RATE_LIMIT_EXCEEDED',
          message:
            'Se han realizado demasiados intentos. Inténtalo de nuevo más tarde.',
        }),
      );
    },
  });
