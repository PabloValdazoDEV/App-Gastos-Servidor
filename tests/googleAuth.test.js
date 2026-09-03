import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/lib/logger.js';
import { createAuthService } from '../src/services/auth.service.js';
import { createGoogleAuthService } from '../src/services/googleAuth.service.js';
import { createAuthPrisma } from './helpers/createAuthPrisma.js';
import { createTestConfig } from './helpers/createTestConfig.js';

const logger = createLogger({ level: 'silent' });
const requestContext = {
  ipAddress: '127.0.0.1',
  userAgent: 'BudgetApp test',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const createFixture = async (overrides = {}) => {
  const prisma = createAuthPrisma();
  const config = createTestConfig({
    ...overrides,
    features: { googleAuth: true, ...overrides.features },
    google: {
      clientId: 'google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-client-secret',
      ...overrides.google,
    },
  });
  const authService = createAuthService({
    prisma,
    config,
    logger,
    emailService: { sendPasswordReset: async () => false },
  });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const googleAuth = createGoogleAuthService({
    prisma,
    config,
    authService,
    jwks: async () => publicKey,
  });

  return { prisma, config, authService, privateKey, googleAuth };
};

const prepareCallback = async ({
  googleAuth,
  config,
  privateKey,
  email,
  startOptions = {
    privacyPolicyAcknowledged: true,
    privacyPolicyVersion: config.privacy.version,
  },
}) => {
  const start = await googleAuth.start(startOptions);
  const authorizationUrl = new URL(start.authorizationUrl);
  const nonce = authorizationUrl.searchParams.get('nonce');
  const state = authorizationUrl.searchParams.get('state');
  const idToken = await new SignJWT({
    email,
    email_verified: true,
    nonce,
    name: 'Persona Google',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(config.google.clientId)
    .setSubject('google-account-id')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

  return {
    code: 'authorization-code',
    state,
    oauthCookie: start.oauthCookie,
    requestContext,
  };
};

describe('Google OpenID Connect', () => {
  it('uses state, nonce, PKCE, verifies the ID token, and creates a session', async () => {
    const fixture = await createFixture();
    const callback = await prepareCallback({
      ...fixture,
      email: 'google@example.com',
    });
    const result = await fixture.googleAuth.callback(callback);

    expect(result.kind).toBe('session');
    expect(result.user.email).toBe('google@example.com');
    expect(fixture.prisma.state.oauthAccounts).toHaveLength(1);
    expect(fixture.prisma.state.sessions).toHaveLength(1);
    expect(fixture.prisma.state.legalDocumentAcceptances).toHaveLength(1);
    expect(fixture.prisma.state.legalDocumentAcceptances[0]).toMatchObject({
      userId: result.user.id,
      documentType: 'PRIVACY_POLICY',
      documentVersion: fixture.config.privacy.version,
      source: 'REGISTRATION',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requires local reauthentication before linking a matching email', async () => {
    const fixture = await createFixture();
    const password = 'Strong-password-1!';

    await fixture.authService.register(
      {
        name: 'Persona Local',
        email: 'local@example.com',
        password,
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: fixture.config.privacy.version,
      },
      requestContext,
    );
    const callback = await prepareCallback({
      ...fixture,
      email: 'local@example.com',
    });
    const pending = await fixture.googleAuth.callback(callback);

    expect(pending.kind).toBe('link_required');
    expect(fixture.prisma.state.oauthAccounts).toHaveLength(0);

    await expect(
      fixture.googleAuth.confirmLink({
        linkCookie: pending.linkCookie,
        password: 'Wrong-password-1!',
        suppliedEmail: 'local@example.com',
        requestContext,
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_LINK_REAUTH_FAILED' });

    const linked = await fixture.googleAuth.confirmLink({
      linkCookie: pending.linkCookie,
      password,
      suppliedEmail: 'local@example.com',
      requestContext,
    });

    expect(linked.user.email).toBe('local@example.com');
    expect(fixture.prisma.state.oauthAccounts).toHaveLength(1);
  });

  it('rejects a new Google account without a signed privacy acknowledgement', async () => {
    const fixture = await createFixture();
    const callback = await prepareCallback({
      ...fixture,
      email: 'unacknowledged@example.com',
      startOptions: {},
    });

    await expect(fixture.googleAuth.callback(callback)).rejects.toMatchObject({
      code: 'PRIVACY_POLICY_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(fixture.prisma.state.users).toHaveLength(0);
    expect(fixture.prisma.state.legalDocumentAcceptances).toHaveLength(0);
  });

  it('rejects a new Google account if the signed policy version became stale', async () => {
    const fixture = await createFixture();
    const callback = await prepareCallback({
      ...fixture,
      email: 'stale@example.com',
    });
    fixture.config.privacy.version = '2026-09-01';

    await expect(fixture.googleAuth.callback(callback)).rejects.toMatchObject({
      code: 'PRIVACY_POLICY_OUTDATED',
    });
    expect(fixture.prisma.state.users).toHaveLength(0);
  });

  it('validates an acknowledged policy before redirecting to Google', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.googleAuth.start({
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: 'outdated-version',
      }),
    ).rejects.toMatchObject({ code: 'PRIVACY_POLICY_OUTDATED' });

    fixture.config.privacy.configured = false;
    await expect(
      fixture.googleAuth.start({
        privacyPolicyAcknowledged: true,
        privacyPolicyVersion: fixture.config.privacy.version,
      }),
    ).rejects.toMatchObject({ code: 'PRIVACY_POLICY_NOT_CONFIGURED' });
  });

  it('lets an existing Google account sign in without acknowledging again', async () => {
    const fixture = await createFixture();
    const firstCallback = await prepareCallback({
      ...fixture,
      email: 'existing-google@example.com',
    });
    await fixture.googleAuth.callback(firstCallback);

    const loginCallback = await prepareCallback({
      ...fixture,
      email: 'existing-google@example.com',
      startOptions: {},
    });
    const result = await fixture.googleAuth.callback(loginCallback);

    expect(result.kind).toBe('session');
    expect(fixture.prisma.state.users).toHaveLength(1);
    expect(fixture.prisma.state.legalDocumentAcceptances).toHaveLength(1);
    expect(fixture.prisma.state.sessions).toHaveLength(2);
  });

  it('rolls back a Google user when its legal evidence cannot be stored', async () => {
    const fixture = await createFixture();
    const callback = await prepareCallback({
      ...fixture,
      email: 'atomic-google@example.com',
    });
    fixture.prisma.legalDocumentAcceptance.create = async () => {
      throw new Error('Acceptance storage unavailable');
    };

    await expect(fixture.googleAuth.callback(callback)).rejects.toThrow(
      'Acceptance storage unavailable',
    );
    expect(fixture.prisma.state.users).toHaveLength(0);
    expect(fixture.prisma.state.oauthAccounts).toHaveLength(0);
    expect(fixture.prisma.state.sessions).toHaveLength(0);
  });
});
