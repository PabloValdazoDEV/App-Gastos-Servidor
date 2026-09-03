import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { createAuthPrisma } from './helpers/createAuthPrisma.js';
import { createTestConfig } from './helpers/createTestConfig.js';

const origin = 'http://localhost:5173';
const householdId = '85709c89-a19b-4f51-94bc-9f0fcc7f37d5';

const createFixture = () => {
  const prisma = createAuthPrisma();
  const config = createTestConfig();
  const app = createApp({
    config,
    prismaClient: prisma,
    logger: createLogger({ level: 'silent' }),
    emailService: {
      enabled: false,
      verify: async () => false,
      sendPasswordReset: async () => false,
    },
  });

  return { app, prisma };
};

describe('application domain router mounting', () => {
  it.each([
    ['/api/households', 'households'],
    [`/api/households/${householdId}/budget`, 'finance'],
    ['/api/notifications', 'notifications'],
  ])('mounts and protects %s (%s)', async (path) => {
    const { app } = createFixture();
    const response = await request(app).get(path).set('Origin', origin).expect(401);

    expect(response.body).toMatchObject({
      success: false,
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('keeps unknown API paths on the standard 404 handler', async () => {
    const { app } = createFixture();
    const response = await request(app)
      .get('/api/definitely-unknown')
      .set('Origin', origin)
      .expect(404);

    expect(response.body.code).toBe('ROUTE_NOT_FOUND');
  });

  it.each([
    ['post', '/api/households'],
    ['post', `/api/households/${householdId}/recurring-expenses`],
    ['patch', '/api/notifications/read-all'],
  ])('shares CSRF protection on %s %s', async (method, path) => {
    const { app } = createFixture();
    const agent = request.agent(app);
    const csrfResponse = await agent
      .get('/api/auth/csrf')
      .set('Origin', origin)
      .expect(200);
    const csrfToken = csrfResponse.body.data.csrfToken;

    await agent
      .post('/api/auth/register')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'router@example.com',
        password: 'Strong-password-1!',
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: '2026-08-26',
      })
      .expect(201);

    const response = await agent[method](path)
      .set('Origin', origin)
      .send({})
      .expect(403);

    expect(response.body.code).toBe('CSRF_TOKEN_INVALID');
  });
});
