import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { createTestConfig } from './helpers/createTestConfig.js';

const buildApp = (overrides) =>
  createApp({
    config: createTestConfig(overrides),
    logger: createLogger({ level: 'silent' }),
  });

describe('HTTP foundation', () => {
  it('allows an exact credentialed CORS origin', async () => {
    const response = await request(buildApp())
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an origin that is not in the allowlist', async () => {
    const response = await request(buildApp())
      .get('/api/health')
      .set('Origin', 'https://attacker.example')
      .expect(403);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.body).toEqual({
      success: false,
      code: 'CORS_ORIGIN_DENIED',
      message: 'El origen de la solicitud no está permitido.',
    });
  });

  it('allows the encoded document filename header in CORS preflight', async () => {
    const response = await request(buildApp())
      .options('/api/households/example/invoices/example/documents')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'content-type,x-csrf-token,x-document-filename',
      )
      .expect(204);

    expect(response.headers['access-control-allow-headers']).toContain(
      'X-Document-Filename',
    );
  });

  it('uses the standard error envelope for unknown routes', async () => {
    const response = await request(buildApp()).get('/api/unknown').expect(404);

    expect(response.body).toEqual({
      success: false,
      code: 'ROUTE_NOT_FOUND',
      message: 'No se encontró la ruta solicitada.',
    });
  });

  it('uses the standard error envelope for malformed JSON', async () => {
    const response = await request(buildApp())
      .post('/api/unknown')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      code: 'INVALID_JSON',
      message: 'El cuerpo de la solicitud no contiene JSON válido.',
    });
  });

  it('applies the general API rate limit', async () => {
    const app = buildApp({
      rateLimit: {
        general: {
          windowMs: 60_000,
          max: 1,
        },
      },
    });

    await request(app).get('/api/unknown').expect(404);
    const response = await request(app).get('/api/unknown').expect(429);

    expect(response.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(response.body.success).toBe(false);
  });

  it('does not rate-limit the liveness health check', async () => {
    const app = buildApp({
      rateLimit: { general: { windowMs: 60_000, max: 1 } },
    });

    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/health').expect(200);
  });
});
