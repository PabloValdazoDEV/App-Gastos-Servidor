import { describe, expect, it, vi } from 'vitest';

import { createLogger, sanitizeLogData } from '../src/lib/logger.js';

describe('structured logger', () => {
  it('never serializes document bytes, AI extraction or personal device identifiers', () => {
    const privateText = 'private-receipt-and-api-secret';
    const safe = sanitizeLogData({
      documentId: 'document-1',
      analysisId: 'analysis-1',
      status: 'COMPLETED',
      usage: { input: 120, output: 60, total: 180 },
      extractedData: { merchant: privateText },
      reviewedData: { merchant: privateText },
      nested: {
        file_data: privateText,
        image_url: privateText,
        base64: privateText,
        documentBytes: privateText,
        rawResponse: { output_text: privateText },
        serialNumber: privateText,
        imei: privateText,
        openai_api_key: privateText,
        binary: Buffer.from(privateText),
        array: new Uint8Array([1, 2, 3]),
        url: `data:image/png;base64,${privateText}`,
      },
    });
    expect(safe.documentId).toBe('document-1');
    expect(safe.analysisId).toBe('analysis-1');
    expect(safe.usage).toEqual({ input: 120, output: 60, total: 180 });
    expect(safe.extractedData).toBe('[REDACTED]');
    expect(safe.reviewedData).toBe('[REDACTED]');
    expect(Object.values(safe.nested)).toEqual(Array(11).fill('[REDACTED]'));
    expect(JSON.stringify(safe)).not.toContain(privateText);
  });

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
