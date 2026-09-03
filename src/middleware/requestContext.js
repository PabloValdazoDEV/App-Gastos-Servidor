import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const getRequestId = (request) => {
  const candidate = request.get('x-request-id');
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
};

export const createRequestContext = (logger) => (request, response, next) => {
  const startedAt = process.hrtime.bigint();
  const requestId = getRequestId(request);
  let logged = false;

  request.id = requestId;
  response.set('X-Request-Id', requestId);

  const logCompletion = (outcome) => {
    if (logged) return;
    logged = true;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    logger.debug('http.request.completed', {
      requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      outcome,
    });
  };

  response.once('finish', () => logCompletion('completed'));
  response.once('close', () => {
    if (!response.writableEnded) logCompletion('aborted');
  });

  next();
};
