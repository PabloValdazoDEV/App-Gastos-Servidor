import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { sha256 } from '../src/utils/crypto.js';
import { createAuthPrisma } from './helpers/createAuthPrisma.js';
import { createTestConfig } from './helpers/createTestConfig.js';

const origin = 'http://localhost:5173';
const password = 'Strong-password-1!';
const privacyFields = {
  privacyPolicyAcknowledged: true,
  privacyPolicyVersion: '2026-08-26',
};

const cookiePair = (setCookies, name) =>
  setCookies.find((cookie) => cookie.startsWith(`${name}=`)).split(';')[0];

const createFixture = (configOverrides = {}) => {
  const prisma = createAuthPrisma();
  const config = createTestConfig(configOverrides);
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

  return { app, config, prisma };
};

const csrf = async (agent) => {
  const response = await agent.get('/api/auth/csrf').set('Origin', origin).expect(200);
  return response.body.data.csrfToken;
};

const post = (agent, path, csrfToken) =>
  agent
    .post(path)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrfToken);

describe('authentication routes', () => {
  it('disables authentication rate limits and CSRF in development', async () => {
    const { app } = createFixture({
      nodeEnv: 'development',
      rateLimit: {
        general: { max: 1 },
        auth: { max: 1 },
      },
    });
    const agent = request.agent(app);
    const credentials = {
      email: 'missing@example.com',
      password,
    };

    await agent
      .post('/api/auth/login')
      .set('Origin', origin)
      .send(credentials)
      .expect(401);
    await agent
      .post('/api/auth/login')
      .set('Origin', origin)
      .send(credentials)
      .expect(401);
  });

  it('registers, authenticates, lists sessions, and logs out', async () => {
    const { app, prisma } = createFixture();
    const agent = request.agent(app);
    const csrfToken = await csrf(agent);

    const registration = await post(agent, '/api/auth/register', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'DEMO@example.com',
        password,
        ...privacyFields,
      })
      .expect(201);

    expect(registration.body.data.user).toMatchObject({
      name: 'Persona Demo',
      email: 'demo@example.com',
    });
    expect(registration.headers['set-cookie'].join(';')).toContain('HttpOnly');
    expect(prisma.state.legalDocumentAcceptances).toHaveLength(1);
    expect(prisma.state.legalDocumentAcceptances[0]).toMatchObject({
      userId: registration.body.data.user.id,
      documentType: 'PRIVACY_POLICY',
      documentVersion: privacyFields.privacyPolicyVersion,
      source: 'REGISTRATION',
    });
    expect(prisma.state.legalDocumentAcceptances[0]).not.toHaveProperty(
      'ipAddress',
    );

    const me = await agent.get('/api/auth/me').set('Origin', origin).expect(200);
    expect(me.body.data.user.email).toBe('demo@example.com');

    const sessions = await agent
      .get('/api/auth/sessions')
      .set('Origin', origin)
      .expect(200);
    expect(sessions.body.data.sessions).toHaveLength(1);
    expect(sessions.body.data.sessions[0].current).toBe(true);

    await post(agent, '/api/auth/logout', csrfToken).expect(200);
    await agent.get('/api/auth/me').set('Origin', origin).expect(401);
  });

  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const { app, config } = createFixture();
    const agent = request.agent(app);
    const csrfResponse = await agent
      .get('/api/auth/csrf')
      .set('Origin', origin)
      .expect(200);
    const csrfToken = csrfResponse.body.data.csrfToken;
    const csrfCookie = cookiePair(
      csrfResponse.headers['set-cookie'],
      config.cookies.csrfName,
    );
    const registration = await post(agent, '/api/auth/register', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'demo@example.com',
        password,
        ...privacyFields,
      })
      .expect(201);
    const oldRefreshCookie = cookiePair(
      registration.headers['set-cookie'],
      config.cookies.refreshName,
    );

    await post(agent, '/api/auth/refresh', csrfToken).expect(200);

    await request(app)
      .post('/api/auth/refresh')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', [csrfCookie, oldRefreshCookie])
      .expect(401);

    await agent.get('/api/auth/me').set('Origin', origin).expect(401);
  });

  it('uses generic recovery responses and consumes reset tokens once', async () => {
    const { app, prisma } = createFixture();
    const agent = request.agent(app);
    const csrfToken = await csrf(agent);

    await post(agent, '/api/auth/register', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'demo@example.com',
        password,
        ...privacyFields,
      })
      .expect(201);

    const existing = await post(agent, '/api/auth/forgot-password', csrfToken)
      .send({ email: 'demo@example.com' })
      .expect(200);
    const missing = await post(agent, '/api/auth/forgot-password', csrfToken)
      .send({ email: 'missing@example.com' })
      .expect(200);
    expect(existing.body).toEqual(missing.body);

    const rawToken = 'a'.repeat(48);
    const user = prisma.state.users[0];
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const newPassword = 'New-strong-password-2!';

    await post(agent, '/api/auth/reset-password', csrfToken)
      .send({ token: rawToken, password: newPassword })
      .expect(200);
    await post(agent, '/api/auth/reset-password', csrfToken)
      .send({ token: rawToken, password: newPassword })
      .expect(400);

    await post(agent, '/api/auth/login', csrfToken)
      .send({ email: 'demo@example.com', password })
      .expect(401);
    await post(agent, '/api/auth/login', csrfToken)
      .send({ email: 'demo@example.com', password: newPassword })
      .expect(200);
  });

  it('revokes individual sessions and all devices without exposing other users', async () => {
    const { app } = createFixture();
    const firstAgent = request.agent(app);
    const firstCsrf = await csrf(firstAgent);

    await post(firstAgent, '/api/auth/register', firstCsrf)
      .send({
        name: 'Persona Demo',
        email: 'demo@example.com',
        password,
        ...privacyFields,
      })
      .expect(201);

    const secondAgent = request.agent(app);
    const secondCsrf = await csrf(secondAgent);
    await post(secondAgent, '/api/auth/login', secondCsrf)
      .send({ email: 'demo@example.com', password })
      .expect(200);

    const sessionResponse = await secondAgent
      .get('/api/auth/sessions')
      .set('Origin', origin)
      .expect(200);
    expect(sessionResponse.body.data.sessions).toHaveLength(2);
    const otherSession = sessionResponse.body.data.sessions.find(
      (session) => !session.current,
    );

    await secondAgent
      .delete(`/api/auth/sessions/${otherSession.id}`)
      .set('Origin', origin)
      .set('X-CSRF-Token', secondCsrf)
      .expect(200);
    await firstAgent.get('/api/auth/me').set('Origin', origin).expect(401);

    await post(secondAgent, '/api/auth/logout-all', secondCsrf).expect(200);
    await secondAgent.get('/api/auth/me').set('Origin', origin).expect(401);
  });

  it('requires valid origin and CSRF and keeps Google disabled safely', async () => {
    const { app } = createFixture();

    const noCsrf = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'demo@example.com', password })
      .expect(403);
    expect(noCsrf.body.code).toBe('CSRF_TOKEN_INVALID');

    const badOrigin = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://attacker.example')
      .send({ email: 'demo@example.com', password })
      .expect(403);
    expect(badOrigin.body.code).toBe('CORS_ORIGIN_DENIED');

    const google = await request(app)
      .get('/api/auth/google/start')
      .set('Origin', origin)
      .expect(404);
    expect(google.body.code).toBe('GOOGLE_AUTH_DISABLED');
  });

  it('publishes only current privacy metadata without allowing stale caches', async () => {
    const { app, config } = createFixture();
    const response = await request(app)
      .get('/api/legal/privacy-policy')
      .set('Origin', origin)
      .expect(200);

    expect(response.body).toEqual({ success: true, data: config.privacy });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('test-csrf-secret');
  });

  it('redirects Google-start privacy errors back to registration', async () => {
    const { app } = createFixture({
      features: { googleAuth: true },
      google: {
        clientId: 'google-client-id.apps.googleusercontent.com',
        clientSecret: 'google-client-secret',
      },
    });

    const validStart = await request(app)
      .get('/api/auth/google/start')
      .query(privacyFields)
      .set('Origin', origin)
      .expect(302);
    expect(validStart.headers.location).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
    );

    const outdatedStart = await request(app)
      .get('/api/auth/google/start')
      .query({
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: 'outdated-version',
      })
      .set('Origin', origin)
      .expect(302);
    expect(outdatedStart.headers.location).toBe(
      'http://localhost:5173/register?privacyError=PRIVACY_POLICY_OUTDATED',
    );
  });

  it('requires an explicit acknowledgement of the current policy version', async () => {
    const { app } = createFixture();
    const agent = request.agent(app);
    const csrfToken = await csrf(agent);
    const baseRegistration = {
      name: 'Persona Demo',
      email: 'privacy@example.com',
      password,
      privacyPolicyVersion: privacyFields.privacyPolicyVersion,
    };

    const missing = await post(agent, '/api/auth/register', csrfToken)
      .send(baseRegistration)
      .expect(400);
    expect(missing.body.details).toContainEqual(
      expect.objectContaining({ field: 'privacyPolicyAcknowledged' }),
    );

    const declined = await post(agent, '/api/auth/register', csrfToken)
      .send({ ...baseRegistration, privacyPolicyAcknowledged: false })
      .expect(400);
    expect(declined.body.details).toContainEqual(
      expect.objectContaining({
        field: 'privacyPolicyAcknowledged',
        message: expect.stringContaining('has leído'),
      }),
    );

    const outdated = await post(agent, '/api/auth/register', csrfToken)
      .send({
        ...baseRegistration,
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: '2026-01-01',
      })
      .expect(409);
    expect(outdated.body.code).toBe('PRIVACY_POLICY_OUTDATED');
  });

  it('starts without legal metadata but fails closed for new registrations', async () => {
    const privacy = {
      configured: false,
      version: null,
      effectiveDate: null,
      controller: {
        name: null,
        contactEmail: null,
        address: null,
        dpoEmail: null,
      },
    };
    const { app } = createFixture({ privacy });
    const policy = await request(app)
      .get('/api/legal/privacy-policy')
      .set('Origin', origin)
      .expect(200);
    expect(policy.body.data).toEqual(privacy);

    const agent = request.agent(app);
    const csrfToken = await csrf(agent);
    const registration = await post(agent, '/api/auth/register', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'privacy@example.com',
        password,
        ...privacyFields,
      })
      .expect(503);
    expect(registration.body.code).toBe('PRIVACY_POLICY_NOT_CONFIGURED');
  });

  it('rolls back the user when privacy evidence cannot be persisted', async () => {
    const { app, prisma } = createFixture();
    prisma.legalDocumentAcceptance.create = async () => {
      throw new Error('Acceptance storage unavailable');
    };
    const agent = request.agent(app);
    const csrfToken = await csrf(agent);

    await post(agent, '/api/auth/register', csrfToken)
      .send({
        name: 'Persona Demo',
        email: 'atomic@example.com',
        password,
        ...privacyFields,
      })
      .expect(500);

    expect(prisma.state.users).toHaveLength(0);
    expect(prisma.state.sessions).toHaveLength(0);
    expect(prisma.state.auditLogs).toHaveLength(0);
    expect(prisma.state.legalDocumentAcceptances).toHaveLength(0);
  });

  describe('session lifecycle in production mode', () => {
    const registerWithCookies = async (app, config) => {
      const csrfResponse = await request(app)
        .get('/api/auth/csrf')
        .set('Origin', origin)
        .expect(200);
      const csrfToken = csrfResponse.body.data.csrfToken;
      const csrfCookie = cookiePair(
        csrfResponse.headers['set-cookie'],
        config.cookies.csrfName,
      );
      const registration = await request(app)
        .post('/api/auth/register')
        .set('Origin', origin)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [csrfCookie])
        .send({
          name: 'Persona Demo',
          email: 'session@example.com',
          password,
          ...privacyFields,
        })
        .expect(201);

      return {
        csrfToken,
        csrfCookie,
        accessCookie: cookiePair(
          registration.headers['set-cookie'],
          config.cookies.authName,
        ),
        refreshCookie: cookiePair(
          registration.headers['set-cookie'],
          config.cookies.refreshName,
        ),
      };
    };

    const clearedCookieNames = (response) =>
      (response.headers['set-cookie'] ?? [])
        .filter((cookie) => /Expires=Thu, 01 Jan 1970/i.test(cookie))
        .map((cookie) => cookie.split('=')[0]);

    it('gives refresh its own limiter so it never consumes the strict login bucket', async () => {
      const { app, config } = createFixture({
        rateLimit: { auth: { max: 2 }, refresh: { max: 3 } },
      });
      const agent = request.agent(app);
      const csrfToken = await csrf(agent);

      // Strict bucket: 1 of 2 used.
      await post(agent, '/api/auth/register', csrfToken)
        .send({
          name: 'Persona Demo',
          email: 'limits@example.com',
          password,
          ...privacyFields,
        })
        .expect(201);

      // More refreshes than the strict limit allows.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await post(agent, '/api/auth/refresh', csrfToken).expect(200);
      }

      const limited = await post(agent, '/api/auth/refresh', csrfToken).expect(429);
      expect(limited.body.code).toBe('AUTH_REFRESH_RATE_LIMIT_EXCEEDED');
      // A throttled refresh must not destroy the session cookies.
      expect(clearedCookieNames(limited)).toEqual([]);
      await agent.get('/api/auth/me').set('Origin', origin).expect(200);

      // Strict bucket still has room for a login: refreshes did not count.
      await post(agent, '/api/auth/login', csrfToken)
        .send({ email: 'limits@example.com', password })
        .expect(200);
      expect(config.rateLimit.auth.max).toBe(2);
    });

    it('uses a generous default refresh limit when none is configured', async () => {
      const { app } = createFixture({ rateLimit: { auth: { max: 1 } } });
      const agent = request.agent(app);
      const csrfToken = await csrf(agent);

      await post(agent, '/api/auth/register', csrfToken)
        .send({
          name: 'Persona Demo',
          email: 'default-limit@example.com',
          password,
          ...privacyFields,
        })
        .expect(201);

      for (let attempt = 0; attempt < 15; attempt += 1) {
        await post(agent, '/api/auth/refresh', csrfToken).expect(200);
      }
    });

    it('keeps cookies when refresh fails for a transient server error', async () => {
      const { app, config, prisma } = createFixture();
      const session = await registerWithCookies(app, config);
      const originalTransaction = prisma.$transaction;
      prisma.$transaction = async () => {
        throw new Error('database unavailable');
      };

      const failed = await request(app)
        .post('/api/auth/refresh')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(500);
      expect(clearedCookieNames(failed)).toEqual([]);

      prisma.$transaction = originalTransaction;
      await request(app)
        .post('/api/auth/refresh')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(200);
    });

    it('logs out with only the refresh cookie when the access token expired', async () => {
      const { app, config, prisma } = createFixture();
      const session = await registerWithCookies(app, config);

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [
          session.csrfCookie,
          session.refreshCookie,
          `${config.cookies.authName}=expired-or-garbage`,
        ])
        .expect(200);

      expect(response.body.data).toEqual({ loggedOut: true });
      expect(clearedCookieNames(response)).toEqual(
        expect.arrayContaining([config.cookies.authName, config.cookies.refreshName]),
      );
      expect(prisma.state.sessions).toHaveLength(1);
      expect(prisma.state.sessions[0]).toMatchObject({
        revocationReason: 'LOGOUT',
      });
      expect(prisma.state.sessions[0].revokedAt).toBeInstanceOf(Date);
      expect(
        prisma.state.auditLogs.filter((entry) => entry.action === 'LOGOUT'),
      ).toHaveLength(1);

      // The revoked refresh token can no longer be used.
      await request(app)
        .post('/api/auth/refresh')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(401);
    });

    it('still logs out with a valid access token only', async () => {
      const { app, config, prisma } = createFixture();
      const session = await registerWithCookies(app, config);

      await request(app)
        .post('/api/auth/logout')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.accessCookie])
        .expect(200);

      expect(prisma.state.sessions[0].revocationReason).toBe('LOGOUT');
    });

    it('answers success and clears cookies even without any session', async () => {
      const { app, config, prisma } = createFixture();
      const session = await registerWithCookies(app, config);

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie])
        .expect(200);

      expect(response.body.data).toEqual({ loggedOut: true });
      expect(clearedCookieNames(response)).toEqual(
        expect.arrayContaining([config.cookies.authName, config.cookies.refreshName]),
      );
      expect(prisma.state.sessions[0].revokedAt).toBeNull();
    });

    it('does not revoke a session with an old, already rotated refresh token', async () => {
      const { app, config, prisma } = createFixture();
      const session = await registerWithCookies(app, config);
      const rotated = await request(app)
        .post('/api/auth/refresh')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(200);
      const currentRefresh = cookiePair(
        rotated.headers['set-cookie'],
        config.cookies.refreshName,
      );

      await request(app)
        .post('/api/auth/logout')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(200);

      const active = prisma.state.sessions.filter((entry) => entry.revokedAt === null);
      expect(active).toHaveLength(1);
      await request(app)
        .post('/api/auth/refresh')
        .set('Origin', origin)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Cookie', [session.csrfCookie, currentRefresh])
        .expect(200);
    });

    it('keeps CSRF protection on logout', async () => {
      const { app, config } = createFixture();
      const session = await registerWithCookies(app, config);

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Origin', origin)
        .set('Cookie', [session.csrfCookie, session.refreshCookie])
        .expect(403);

      expect(response.body.code).toBe('CSRF_TOKEN_INVALID');
    });
  });
});
