import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevelopmentDate } from '../src/middleware/developmentDate.js';
import { businessToday, withBusinessDate } from '../src/services/businessClock.service.js';
import { dateOrToday } from '../src/modules/finance/finance.service.js';
import { householdToday } from '../src/modules/purchases/warranty.js';
import { toIsoDate } from '../src/services/date.service.js';
import { createCorsOptions } from '../src/config/cors.js';

function appFor(environment) {
  const app = express();
  app.use(createDevelopmentDate(environment));
  app.get('/', async (_request, response) => {
    await Promise.resolve();
    response.json({ today: toIsoDate(dateOrToday()), purchaseToday: toIsoDate(householdToday('Europe/Madrid')) });
  });
  app.use((error, _request, response, _next) => response.status(error.statusCode ?? 500).json({ code: error.code }));
  return app;
}

describe('development business date', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the selected civil date for finance and purchases without changing the real clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const response = await request(appFor('development')).get('/').set('X-Development-Date', '2026-10-29').expect(200);
    expect(response.body).toEqual({ today: '2026-10-29', purchaseToday: '2026-10-29' });
    expect(new Date().toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(toIsoDate(businessToday())).toBe('2026-10-01');
    expect((await request(appFor('development')).get('/').expect(200)).body.today).toBe('2026-10-01');
  });

  it.each(['production', 'test'])('rejects simulated dates in %s', async (environment) => {
    const response = await request(appFor(environment)).get('/').set('X-Development-Date', '2026-10-29').expect(400);
    expect(response.body.code).toBe('DEVELOPMENT_DATE_DISABLED');
    expect(createCorsOptions([], environment).allowedHeaders).not.toContain('X-Development-Date');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-10-29T10:00:00Z'])('rejects invalid civil date %s', async (date) => {
    expect((await request(appFor('development')).get('/').set('X-Development-Date', date).expect(400)).body.code).toBe('INVALID_DEVELOPMENT_DATE');
  });

  it('keeps concurrent overrides isolated and honors explicit calculation dates', async () => {
    const results = await Promise.all(['2026-10-29', '2027-01-02'].map((date) => withBusinessDate(date, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(toIsoDate(dateOrToday('2025-02-01'))).toBe('2025-02-01');
      return toIsoDate(businessToday());
    })));
    expect(results).toEqual(['2026-10-29', '2027-01-02']);
    expect(createCorsOptions([], 'development').allowedHeaders).toContain('X-Development-Date');
  });
});
