import { AppError } from '../errors/AppError.js';
import { csrfCookieOptions, parseCookies } from '../utils/cookies.js';
import { hmacSha256, randomToken, safeEqual } from '../utils/crypto.js';
import { sendSuccess } from '../utils/httpResponses.js';

const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CLOCK_TOLERANCE_MS = 60_000;

const getRequestOrigin = (request) => {
  const origin = request.get('origin');

  if (origin) return origin;

  const referer = request.get('referer');

  if (!referer) return null;

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
};

export const createCsrfToken = (secret, now = Date.now()) => {
  const payload = `v1.${randomToken(24)}.${now}`;
  return `${payload}.${hmacSha256(secret, payload)}`;
};

export const verifyCsrfToken = (token, secret, now = Date.now()) => {
  if (typeof token !== 'string') return false;

  const segments = token.split('.');

  if (segments.length !== 4 || segments[0] !== 'v1') return false;

  const payload = segments.slice(0, 3).join('.');
  const timestamp = Number(segments[2]);
  const age = now - timestamp;

  if (
    !Number.isSafeInteger(timestamp) ||
    age < -CLOCK_TOLERANCE_MS ||
    age > TOKEN_MAX_AGE_MS
  ) {
    return false;
  }

  return safeEqual(segments[3], hmacSha256(secret, payload));
};

export const createCsrfTokenHandler = ({ config }) =>
  (_request, response) => {
    const csrfToken = createCsrfToken(config.csrf.secret);

    response.cookie(
      config.cookies.csrfName,
      csrfToken,
      csrfCookieOptions(config, TOKEN_MAX_AGE_MS),
    );

    return sendSuccess(response, { csrfToken });
  };

export const createCsrfProtection = ({ config }) =>
  (request, _response, next) => {
    const requestOrigin = getRequestOrigin(request);

    if (!requestOrigin || !config.cors.origins.includes(requestOrigin)) {
      next(
        new AppError({
          statusCode: 403,
          code: 'ORIGIN_DENIED',
          message: 'No se pudo verificar el origen de la solicitud.',
        }),
      );
      return;
    }

    const headerToken = request.get('x-csrf-token');
    const cookieToken = parseCookies(request.get('cookie'))[
      config.cookies.csrfName
    ];

    if (
      !headerToken ||
      !cookieToken ||
      !safeEqual(headerToken, cookieToken) ||
      !verifyCsrfToken(headerToken, config.csrf.secret)
    ) {
      next(
        new AppError({
          statusCode: 403,
          code: 'CSRF_TOKEN_INVALID',
          message: 'La protección de la solicitud ha caducado o no es válida.',
        }),
      );
      return;
    }

    next();
  };
