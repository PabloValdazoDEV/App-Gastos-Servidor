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

// /auth/refresh is called automatically by every open tab/device roughly once
// per access-token lifetime (15 min). Several devices of one household share
// the same public IP, so it needs its own, much more generous bucket instead
// of sharing the brute-force limiter used by login/register/recovery.
export const DEFAULT_AUTH_REFRESH_RATE_LIMIT = Object.freeze({
  windowMs: 15 * 60 * 1_000,
  max: 120,
});

export const createAuthRefreshRateLimiter = ({
  windowMs = DEFAULT_AUTH_REFRESH_RATE_LIMIT.windowMs,
  max = DEFAULT_AUTH_REFRESH_RATE_LIMIT.max,
} = {}) =>
  rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler(_request, _response, next) {
      next(
        new AppError({
          statusCode: 429,
          code: 'AUTH_REFRESH_RATE_LIMIT_EXCEEDED',
          message:
            'Se han realizado demasiadas renovaciones de sesión. Inténtalo de nuevo en unos minutos.',
        }),
      );
    },
  });
