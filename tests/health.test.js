import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { createTestConfig } from './helpers/createTestConfig.js';

describe('GET /api/health', () => {
  let app;

  beforeEach(() => {
    app = createApp({
      config: createTestConfig(),
      logger: createLogger({ level: 'silent' }),
    });
  });

  it('returns the standard success envelope without accessing the database', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        status: 'ok',
        service: 'BudgetApp Test',
        environment: 'test',
      },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sets security headers and does not disclose Express', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps a safe caller request ID for end-to-end tracing', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'frontend:request-123')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('frontend:request-123');
  });

  it('replaces malformed request IDs', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('X-Request-Id', 'not a safe request id')
      .expect(200);

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
