import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/errors/AppError.js';
import { createHouseholdDomainRouter } from '../src/modules/household-domain/index.js';

const userId = '10000000-0000-4000-8000-000000000001';

const createServiceStubs = () => ({
  households: {
    list: vi.fn().mockResolvedValue({
      items: [{ id: crypto.randomUUID(), name: 'Casa' }],
      meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    }),
    create: vi.fn().mockImplementation(({ input }) =>
      Promise.resolve({ id: crypto.randomUUID(), ...input }),
    ),
    get: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
  people: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateDistribution: vi.fn(),
    archive: vi.fn(),
  },
  access: {
    list: vi.fn(),
    update: vi.fn(),
    revoke: vi.fn(),
    transferOwnership: vi.fn(),
  },
  invitations: {
    list: vi.fn(),
    create: vi.fn(),
    preview: vi.fn().mockResolvedValue({ household: { name: 'Casa' } }),
    accept: vi.fn(),
    revoke: vi.fn(),
  },
  categories: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  },
});

const authenticate = (request_, _response, next) => {
  if (request_.get('Authorization') !== 'Bearer test') {
    next(
      new AppError({
        statusCode: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Necesitas iniciar sesión para continuar.',
      }),
    );
    return;
  }

  request_.auth = { userId, sessionId: crypto.randomUUID() };
  next();
};

const requireCsrf = (request_, _response, next) => {
  if (request_.get('X-CSRF-Token') !== 'valid') {
    next(
      new AppError({
        statusCode: 403,
        code: 'CSRF_VALIDATION_FAILED',
        message: 'La protección CSRF ha rechazado la solicitud.',
      }),
    );
    return;
  }

  next();
};

const buildApp = (services) => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createHouseholdDomainRouter({ services, authenticate, requireCsrf }),
  );
  app.use((error, _request, response, _next) => {
    response.status(error.statusCode ?? 500).json({
      success: false,
      code: error.code ?? 'INTERNAL_SERVER_ERROR',
      message: error.message,
    });
  });
  return app;
};

describe('household domain router contract', () => {
  let services;
  let app;

  beforeEach(() => {
    services = createServiceStubs();
    app = buildApp(services);
  });

  it('keeps invitation preview public without skipping body validation', async () => {
    const response = await request(app)
      .post('/api/invitations/preview')
      .send({ token: 'a'.repeat(43) })
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: { household: { name: 'Casa' } },
    });
    expect(services.invitations.preview).toHaveBeenCalledWith({
      token: 'a'.repeat(43),
    });
  });

  it('requires authentication for household reads', async () => {
    const response = await request(app).get('/api/households').expect(401);

    expect(response.body.code).toBe('AUTHENTICATION_REQUIRED');
    expect(services.households.list).not.toHaveBeenCalled();
  });

  it('passes the authenticated user to services', async () => {
    const response = await request(app)
      .get('/api/households')
      .set('Authorization', 'Bearer test')
      .expect(200);

    expect(response.body.meta.total).toBe(1);
    expect(services.households.list).toHaveBeenCalledWith({
      actorUserId: userId,
      page: 1,
      pageSize: 25,
      includeArchived: false,
    });
  });

  it('requires CSRF on mutations and returns 201 after validation', async () => {
    await request(app)
      .post('/api/households')
      .set('Authorization', 'Bearer test')
      .send({ name: 'Casa segura' })
      .expect(403);
    expect(services.households.create).not.toHaveBeenCalled();

    const response = await request(app)
      .post('/api/households')
      .set('Authorization', 'Bearer test')
      .set('X-CSRF-Token', 'valid')
      .send({ name: 'Casa segura' })
      .expect(201);

    expect(response.body.data).toMatchObject({
      name: 'Casa segura',
      contributionMode: 'PERCENTAGE',
      currentBalanceCents: 0,
      people: [],
    });
  });

  it('refuses to construct mutable routes without CSRF middleware', () => {
    expect(() =>
      createHouseholdDomainRouter({ services }),
    ).toThrowError(/CSRF middleware/);
  });
});

