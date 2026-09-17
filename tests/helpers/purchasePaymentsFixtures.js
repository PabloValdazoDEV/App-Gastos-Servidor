import express from 'express';
import request from 'supertest';
import { createPurchasesRouter } from '../../src/modules/purchases/index.js';
import { createFinanceRouter } from '../../src/modules/finance/index.js';

export const financingInput = {
  provider: 'Financiera de ejemplo', downPaymentCents: 20_000, downPaymentPaidAt: null,
  installmentCount: 20, installmentAmountCents: 5500,
  firstInstallmentDate: '2026-10-15', financingTotalCents: 110_000,
};
export const purchaseInput = {
  merchant: 'Apple Store', purchaseDate: '2026-09-17', totalCents: 120_000,
  ownershipType: 'HOUSEHOLD', items: [{ name: 'Móvil', brand: 'Apple' }],
};
export const financedPurchaseInput = { ...purchaseInput, paymentMethod: 'FINANCED', financing: financingInput };

export function paymentsTestApp(prisma) {
  const app = express();
  app.use(express.json());
  const authenticate = (req, res, next) => {
    const userId = req.get('authorization')?.replace(/^Bearer /, '');
    if (!userId) return res.status(401).json({ code: 'AUTHENTICATION_REQUIRED' });
    req.auth = { userId };
    next();
  };
  const requireCsrf = (req, res, next) => {
    if (req.get('x-csrf-token') !== 'payment-test-csrf') return res.status(403).json({ code: 'CSRF_TOKEN_INVALID' });
    next();
  };
  const dependencies = { prisma, authenticate, requireCsrf };
  app.use('/api', createPurchasesRouter(dependencies));
  app.use('/api', createFinanceRouter(dependencies));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? error.status ?? (error.issues ? 400 : 500))
    .json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message, details: error.issues }));
  return app;
}

export const authenticatedPayment = (operation, userId) => operation.set('Authorization', `Bearer ${userId}`);
export const mutablePayment = (operation, userId) => authenticatedPayment(operation, userId).set('X-CSRF-Token', 'payment-test-csrf');
export const createFinancedPurchase = async (app, path, userId, input = {}) =>
  (await mutablePayment(request(app).post(path), userId).send({ ...financedPurchaseInput, ...input }).expect(201)).body.data;
