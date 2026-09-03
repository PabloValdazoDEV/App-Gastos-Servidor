import { ZodError } from 'zod';

import { AppError } from '../errors/AppError.js';
import { sendError } from '../utils/httpResponses.js';

const normalizeError = (error) => {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Algunos datos de la solicitud no son válidos.',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
      cause: error,
    });
  }

  if (error?.type === 'entity.parse.failed') {
    return new AppError({
      statusCode: 400,
      code: 'INVALID_JSON',
      message: 'El cuerpo de la solicitud no contiene JSON válido.',
      cause: error,
    });
  }

  if (error?.type === 'entity.too.large') {
    return new AppError({
      statusCode: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'El cuerpo de la solicitud supera el tamaño permitido.',
      cause: error,
    });
  }

  return new AppError({
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Se produjo un error interno.',
    cause: error,
  });
};

export const createErrorHandler = ({ logger, nodeEnv }) =>
  (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const normalizedError = normalizeError(error);
    const logData = {
      requestId: request.id,
      method: request.method,
      path: request.path,
      statusCode: normalizedError.statusCode,
      errorCode: normalizedError.code,
    };

    if (nodeEnv !== 'production' && !error?.isOperational) {
      logData.errorName = error?.name ?? 'Error';
      logData.errorMessage = error?.message ?? String(error);
      logData.stack = error?.stack;
    }

    if (normalizedError.statusCode >= 500) {
      logger.error('http.request.failed', logData);
    } else {
      logger.warn('http.request.rejected', logData);
    }

    sendError(response, normalizedError);
  };
