import express from 'express';
import request from 'supertest';
import { createPurchasesRouter } from '../../src/modules/purchases/index.js';

export const documentBodies = {
  pdf: Buffer.from('%PDF-1.7\nprivate purchase document\n%%EOF', 'ascii'),
  jpeg: Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ]),
  png: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x16, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([0x0a, 0, 0, 0]), Buffer.alloc(10)]),
};

export const supportedDocuments = [
  ['application/pdf', documentBodies.pdf, '.pdf'],
  ['image/jpeg', documentBodies.jpeg, '.jpg'],
  ['image/png', documentBodies.png, '.png'],
  ['image/webp', documentBodies.webp, '.webp'],
];

export function documentsTestApp(prisma, { documentStorage, financeRouter } = {}) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const authenticate = (req, res, next) => {
    const userId = req.get('authorization')?.replace(/^Bearer /, '');
    if (!userId) return res.status(401).json({ code: 'AUTHENTICATION_REQUIRED' });
    req.auth = { userId };
    next();
  };
  const requireCsrf = (req, res, next) => {
    if (req.get('x-csrf-token') !== 'document-test-csrf') return res.status(403).json({ code: 'CSRF_TOKEN_INVALID' });
    next();
  };
  const dependencies = { prisma, authenticate, requireCsrf, ...(documentStorage ? { documentStorage } : {}) };
  app.use('/api', createPurchasesRouter(dependencies));
  if (financeRouter) app.use('/api', financeRouter(dependencies));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? error.status ?? (error.issues ? 400 : 500))
    .json({ code: error.code ?? 'VALIDATION_ERROR', message: error.message, details: error.issues }));
  return app;
}

export const authenticated = (operation, userId) => operation.set('Authorization', `Bearer ${userId}`);
export const mutable = (operation, userId) => authenticated(operation, userId).set('X-CSRF-Token', 'document-test-csrf');
export const upload = (app, path, userId, {
  content = documentBodies.pdf, contentType = 'application/pdf', filename = 'Ticket.pdf', query = { type: 'RECEIPT' },
} = {}) => mutable(request(app).post(path), userId).query(query)
  .set('Content-Type', contentType).set('X-Document-Filename', encodeURIComponent(filename)).send(content);

export function collectBinary(response, callback) {
  const parts = [];
  response.on('data', (chunk) => parts.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(parts)));
  response.on('error', callback);
}
