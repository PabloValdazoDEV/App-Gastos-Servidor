import { describe, expect, it } from 'vitest';

import {
  createCsrfToken,
  verifyCsrfToken,
} from '../src/middleware/csrf.js';
import {
  hashPassword,
  verifyPassword,
} from '../src/services/password.service.js';
import { createTokenService } from '../src/services/token.service.js';
import { createTestConfig } from './helpers/createTestConfig.js';

describe('authentication security primitives', () => {
  it('supports long passwords without bcrypt truncation collisions', async () => {
    const sharedPrefix = 'Aa1!'.repeat(30);
    const passwordHash = await hashPassword(`${sharedPrefix}left`, 8);

    await expect(
      verifyPassword(`${sharedPrefix}left`, passwordHash),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(`${sharedPrefix}right`, passwordHash),
    ).resolves.toBe(false);
  });

  it('signs access and refresh tokens with separate validated purposes', async () => {
    const tokens = createTokenService(createTestConfig());
    const access = await tokens.signAccess({
      userId: '2e7999d1-5585-4424-97d8-e777e39d8aa4',
      sessionId: '6b382315-b3d4-47bd-a89e-e71995af827e',
    });
    const refresh = await tokens.signRefresh({
      userId: '2e7999d1-5585-4424-97d8-e777e39d8aa4',
      sessionId: '6b382315-b3d4-47bd-a89e-e71995af827e',
      familyId: '9d876d8f-86cc-4a30-9bc8-702cdfe585cf',
    });

    await expect(tokens.verifyAccess(access)).resolves.toMatchObject({
      tokenType: 'access+jwt',
    });
    await expect(tokens.verifyRefresh(refresh)).resolves.toMatchObject({
      tokenType: 'refresh+jwt',
    });
    await expect(tokens.verifyAccess(refresh)).rejects.toThrow();
  });

  it('rejects tampered and expired CSRF tokens', () => {
    const secret = 'csrf-test-secret-that-is-longer-than-32-characters';
    const issuedAt = Date.now();
    const token = createCsrfToken(secret, issuedAt);

    expect(verifyCsrfToken(token, secret, issuedAt + 1_000)).toBe(true);
    expect(verifyCsrfToken(`${token}x`, secret, issuedAt + 1_000)).toBe(false);
    expect(
      verifyCsrfToken(token, secret, issuedAt + 24 * 60 * 60 * 1_000 + 1),
    ).toBe(false);
  });
});
