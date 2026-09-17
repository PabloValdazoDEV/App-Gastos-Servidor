import { describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../src/middleware/errorHandler.js';
import { ReceiptAnalysisError } from '../src/services/receiptAnalyzer.js';

describe('private purchase analysis HTTP error boundary', () => {
  it.each([
    ['malformed JSON', () => Object.assign(new SyntaxError('private-ticket-content sk-private-test'), { type: 'entity.parse.failed' }), 'INVALID_JSON'],
    ['database error', () => new Error('private-ticket-content sk-private-test'), 'INTERNAL_SERVER_ERROR'],
    ['provider timeout', () => new ReceiptAnalysisError('AI_TIMEOUT'), 'AI_TIMEOUT'],
  ])('does not expose or log private content on %s, including development', (_name, buildError, expectedCode) => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const response = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const error = buildError();
    error.stack = 'private-ticket-content sk-private-test';
    const request = { id: 'request-1', method: 'POST', path: '/api/households/home/purchases/purchase/documents/document/analyses/analysis/confirm' };
    createErrorHandler({ logger, nodeEnv: 'development' })(error, request, response, vi.fn());
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: expectedCode, success: false }));
    const serialized = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, response.json.mock.calls]);
    expect(serialized).not.toContain('private-ticket-content');
    expect(serialized).not.toContain('sk-private-test');
    expect(serialized).not.toContain('stack');
    expect(serialized).toContain('request-1');
    expect(serialized).toContain(expectedCode);
  });
});
