import { AppError } from '../errors/AppError.js';

export const createCorsOptions = (allowedOrigins) => {
  const allowlist = new Set(allowedOrigins);

  return {
    origin(origin, callback) {
      if (origin === undefined || allowlist.has(origin)) {
        callback(null, true);
        return;
      }

      callback(
        new AppError({
          statusCode: 403,
          code: 'CORS_ORIGIN_DENIED',
          message: 'El origen de la solicitud no está permitido.',
        }),
      );
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Authorization',
      'Content-Type',
      'X-CSRF-Token',
      'X-Document-Filename',
      'X-Request-Id',
    ],
    exposedHeaders: [
      'RateLimit',
      'RateLimit-Policy',
      'Retry-After',
      'X-Request-Id',
    ],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
};
