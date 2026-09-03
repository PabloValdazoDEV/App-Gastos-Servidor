import { describe, expect, it } from 'vitest';

import {
  generateInvitationToken,
  hashInvitationToken,
  maskInvitationEmail,
} from '../src/modules/invitations/invitations.service.js';

describe('invitation token security', () => {
  it('generates high-entropy URL-safe tokens', () => {
    const first = generateInvitationToken();
    const second = generateInvitationToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('stores a deterministic SHA-256 hash instead of the raw token', () => {
    const token = 'a'.repeat(43);
    const hash = hashInvitationToken(token);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(token)).toBe(hash);
  });

  it('only exposes a masked email in public previews', () => {
    expect(maskInvitationEmail('persona@example.com')).toBe(
      'pe*****@example.com',
    );
    expect(maskInvitationEmail(null)).toBeNull();
  });
});

