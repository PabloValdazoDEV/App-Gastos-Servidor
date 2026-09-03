import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/lib/logger.js';

describe('structured logger', () => {
  it('redacts sensitive fields recursively', () => {
    const lines = [];
    const destination = {
      write: vi.fn((line) => lines.push(line)),
    };
    const logger = createLogger({ level: 'debug', destination });

    logger.info('security.test', {
      requestId: 'request-1',
      authorization: 'Bearer should-not-appear',
      nested: {
        password: 'should-not-appear',
        privateKey: 'private-should-not-appear',
        value: 'safe',
      },
    });

    const entry = JSON.parse(lines[0]);

    expect(entry.authorization).toBe('[REDACTED]');
    expect(entry.nested.password).toBe('[REDACTED]');
    expect(entry.nested.privateKey).toBe('[REDACTED]');
    expect(entry.nested.value).toBe('safe');
    expect(lines[0]).not.toContain('should-not-appear');
  });

  it('does not let caller data overwrite reserved fields', () => {
    const lines = [];
    const destination = { write: vi.fn((line) => lines.push(line)) };
    const logger = createLogger({ level: 'debug', destination });

    logger.info('security.real-event', {
      event: 'forged-event',
      level: 'fatal',
      timestamp: 'forged-time',
    });

    const entry = JSON.parse(lines[0]);

    expect(entry.event).toBe('security.real-event');
    expect(entry.level).toBe('info');
    expect(entry.timestamp).not.toBe('forged-time');
  });
});
