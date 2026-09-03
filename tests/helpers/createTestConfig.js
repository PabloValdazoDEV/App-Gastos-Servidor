export const createTestConfig = (overrides = {}) => {
  const baseConfig = {
    nodeEnv: 'test',
    app: {
      name: 'BudgetApp Test',
      serverUrl: 'http://localhost:3000',
      clientUrl: 'http://localhost:5173',
    },
    cors: {
      origins: ['http://localhost:5173'],
    },
    jwt: {
      accessSecret: 'test-access-secret-with-at-least-32-chars',
      refreshSecret: 'test-refresh-secret-with-at-least-32-chars',
      accessTtl: '15m',
      refreshTtlDays: 30,
    },
    cookies: {
      authName: 'access_token',
      refreshName: 'refresh_token',
      csrfName: 'csrf_token',
      domain: undefined,
      secure: false,
      sameSite: 'lax',
    },
    csrf: {
      secret: 'test-csrf-secret-with-at-least-32-characters',
    },
    bcrypt: { rounds: 8 },
    features: { googleAuth: false, email: false, webPush: false },
    google: {
      clientId: undefined,
      clientSecret: undefined,
      callbackUrl: 'http://localhost:3000/api/auth/google/callback',
    },
    email: {
      host: undefined,
      port: 587,
      secure: false,
      user: undefined,
      password: undefined,
      fromName: 'BudgetApp',
      fromAddress: 'no-reply@example.com',
    },
    tokens: { passwordResetTtlMinutes: 30, invitationTtlDays: 7 },
    defaults: {
      timezone: 'Europe/Madrid',
      locale: 'es-ES',
      currency: 'EUR',
      safetyMarginPercent: 10,
      contributionDay: 1,
    },
    privacy: {
      configured: true,
      version: '2026-08-26',
      effectiveDate: '2026-08-26',
      controller: {
        name: 'BudgetApp Test',
        contactEmail: 'privacy@example.com',
        address: null,
        dpoEmail: null,
      },
    },
    rateLimit: {
      general: {
        windowMs: 60_000,
        max: 100,
      },
      auth: {
        windowMs: 60_000,
        max: 100,
      },
    },
    security: {
      trustProxyHops: 0,
    },
  };

  return {
    ...baseConfig,
    ...overrides,
    app: { ...baseConfig.app, ...overrides.app },
    cors: { ...baseConfig.cors, ...overrides.cors },
    jwt: { ...baseConfig.jwt, ...overrides.jwt },
    cookies: { ...baseConfig.cookies, ...overrides.cookies },
    csrf: { ...baseConfig.csrf, ...overrides.csrf },
    bcrypt: { ...baseConfig.bcrypt, ...overrides.bcrypt },
    features: { ...baseConfig.features, ...overrides.features },
    google: { ...baseConfig.google, ...overrides.google },
    email: { ...baseConfig.email, ...overrides.email },
    tokens: { ...baseConfig.tokens, ...overrides.tokens },
    defaults: { ...baseConfig.defaults, ...overrides.defaults },
    privacy: {
      ...baseConfig.privacy,
      ...overrides.privacy,
      controller: {
        ...baseConfig.privacy.controller,
        ...overrides.privacy?.controller,
      },
    },
    rateLimit: {
      ...baseConfig.rateLimit,
      ...overrides.rateLimit,
      general: {
        ...baseConfig.rateLimit.general,
        ...overrides.rateLimit?.general,
      },
      auth: {
        ...baseConfig.rateLimit.auth,
        ...overrides.rateLimit?.auth,
      },
    },
    security: { ...baseConfig.security, ...overrides.security },
  };
};
