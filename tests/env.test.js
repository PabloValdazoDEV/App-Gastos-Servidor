import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  loadEnv,
} from '../src/config/env.js';

const secret = (character) => character.repeat(64);

const validEnvironment = (overrides = {}) => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/budgetapp?schema=public',
  CLIENT_URL: 'http://localhost:5173',
  CLIENT_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: secret('a'),
  JWT_REFRESH_SECRET: secret('b'),
  CSRF_SECRET: secret('c'),
  ...overrides,
});

describe('loadEnv', () => {
  it('parses booleans explicitly instead of treating "false" as true', () => {
    const config = loadEnv(
      validEnvironment({
        COOKIE_SECURE: 'false',
        GOOGLE_AUTH_ENABLED: 'false',
      }),
    );

    expect(config.cookies.secure).toBe(false);
    expect(config.features.googleAuth).toBe(false);
  });

  it('trims, canonicalizes, and deduplicates exact CORS origins', () => {
    const config = loadEnv(
      validEnvironment({
        CLIENT_ORIGINS:
          'http://localhost:5173, https://app.example.com/,http://localhost:5173',
      }),
    );

    expect(config.cors.origins).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
  });

  it('reports a missing required variable without printing secret values', () => {
    const environment = validEnvironment();
    delete environment.DATABASE_URL;

    expect(() => loadEnv(environment)).toThrow(EnvironmentValidationError);
    expect(() => loadEnv(environment)).toThrow(
      'Missing required environment variable: DATABASE_URL',
    );
  });

  it('requires provider credentials only when the feature is enabled', () => {
    expect(() =>
      loadEnv(validEnvironment({ GOOGLE_AUTH_ENABLED: 'true' })),
    ).toThrow('Missing required environment variable: GOOGLE_CLIENT_ID');
  });

  it('reports malformed URLs as environment validation errors', () => {
    expect(() =>
      loadEnv(validEnvironment({ CLIENT_URL: 'not-a-url' })),
    ).toThrow(EnvironmentValidationError);
  });

  it('requires secure cookies for SameSite=None', () => {
    expect(() =>
      loadEnv(
        validEnvironment({
          COOKIE_SAME_SITE: 'none',
          COOKIE_SECURE: 'false',
        }),
      ),
    ).toThrow('Invalid environment variable COOKIE_SECURE');
  });

  it('starts with privacy registration disabled when legal metadata is absent', () => {
    const config = loadEnv(validEnvironment());

    expect(config.privacy).toEqual({
      configured: false,
      version: null,
      effectiveDate: null,
      controller: {
        name: null,
        contactEmail: null,
        address: null,
        dpoEmail: null,
      },
    });
  });

  it('enables privacy registration only with all mandatory public metadata', () => {
    const config = loadEnv(
      validEnvironment({
        PRIVACY_POLICY_VERSION: ' 2026-08-26 ',
        PRIVACY_POLICY_EFFECTIVE_DATE: '2026-08-26',
        PRIVACY_CONTROLLER_NAME: ' BudgetApp Responsable ',
        PRIVACY_CONTROLLER_CONTACT_EMAIL: ' PRIVACY@EXAMPLE.COM ',
        PRIVACY_CONTROLLER_ADDRESS: ' Calle Ejemplo 1 ',
        PRIVACY_DPO_EMAIL: ' DPO@EXAMPLE.COM ',
      }),
    );

    expect(config.privacy).toEqual({
      configured: true,
      version: '2026-08-26',
      effectiveDate: '2026-08-26',
      controller: {
        name: 'BudgetApp Responsable',
        contactEmail: 'privacy@example.com',
        address: 'Calle Ejemplo 1',
        dpoEmail: 'dpo@example.com',
      },
    });
  });

  it('rejects malformed optional privacy metadata without making it mandatory', () => {
    expect(() =>
      loadEnv(
        validEnvironment({
          PRIVACY_POLICY_EFFECTIVE_DATE: '2026-02-30',
        }),
      ),
    ).toThrow('Invalid environment variable PRIVACY_POLICY_EFFECTIVE_DATE');
    expect(() =>
      loadEnv(
        validEnvironment({
          PRIVACY_CONTROLLER_CONTACT_EMAIL: 'not-an-email',
        }),
      ),
    ).toThrow('Invalid environment variable PRIVACY_CONTROLLER_CONTACT_EMAIL');
  });
});
