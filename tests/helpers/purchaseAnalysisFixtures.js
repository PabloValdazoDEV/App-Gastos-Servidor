import express from 'express';
import { vi } from 'vitest';
import { createPurchasesRouter } from '../../src/modules/purchases/index.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';

export const receiptData = {
  documentType: 'RECEIPT', merchant: { name: 'Mercadona', confidence: 'HIGH' },
  purchaseDate: { value: '2026-09-17', confidence: 'HIGH' }, currency: 'EUR',
  subtotalCents: null, taxCents: null, discountCents: null, totalCents: 870, documentNumber: null,
  items: [
    { name: 'Producto A', quantity: 1, unitPriceCents: 550, totalPriceCents: 550, brand: null, model: null, confidence: 'HIGH' },
    { name: 'Producto B', quantity: 1, unitPriceCents: 320, totalPriceCents: 320, brand: null, model: null, confidence: 'HIGH' },
  ], needsReview: true, warnings: [],
};
export const receiptResult = { extractedData: receiptData, provider: 'OPENAI', model: 'test-receipt-model', inputTokens: 100, outputTokens: 50, totalTokens: 150 };
export const makeReceiptAnalyzer = () => ({ provider: 'OPENAI', model: 'test-receipt-model', analyze: vi.fn(async () => structuredClone(receiptResult)) });
export function reviewedBody(analysis, overrides = {}) {
  return {
    purchaseVersion: analysis.purchaseVersion,
    reviewedData: { merchant: 'Comercio revisado', purchaseDate: '2026-09-16', totalCents: 900, currency: 'EUR', items: [
      { name: 'Producto corregido', quantity: 2, unitPriceCents: 450, totalPriceCents: 900, brand: 'Marca revisada', model: null },
    ] },
    apply: { merchant: true, purchaseDate: true, total: true, items: 'ADD' }, acknowledgeTotalMismatch: false,
    ...overrides,
  };
}
export function analysisTestApp(prisma, { receiptAnalyzer = makeReceiptAnalyzer(), documentStorage, aiConfig, logger = { warn: vi.fn(), error: vi.fn() } } = {}) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const authenticate = (req, res, next) => {
    const userId = req.get('authorization')?.replace(/^Bearer /, '');
    if (!userId) return res.status(401).json({ code: 'AUTHENTICATION_REQUIRED' });
    req.auth = { userId }; next();
  };
  const requireCsrf = (req, res, next) => {
    if (req.get('x-csrf-token') !== 'document-test-csrf') return res.status(403).json({ code: 'CSRF_TOKEN_INVALID' });
    next();
  };
  app.use('/api', createPurchasesRouter({ prisma, authenticate, requireCsrf, receiptAnalyzer, documentStorage, aiConfig }));
  app.use(createErrorHandler({ logger, nodeEnv: 'development' }));
  return app;
}
