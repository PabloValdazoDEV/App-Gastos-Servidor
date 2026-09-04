import { Router } from 'express';
import { z } from 'zod';

import { sendSuccess } from '../../utils/httpResponses.js';
import { createAccessService } from '../access/access.service.js';
import { updateAccessBodySchema } from '../access/access.schemas.js';
import { createCategoriesService } from '../categories/categories.service.js';
import {
  createCategoryBodySchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from '../categories/category.schemas.js';
import {
  createHouseholdBodySchema,
  listHouseholdsQuerySchema,
  transferOwnershipBodySchema,
  updateHouseholdBodySchema,
} from '../households/household.schemas.js';
import { createHouseholdsService } from '../households/households.service.js';
import { createInvitationsService } from '../invitations/invitations.service.js';
import {
  createInvitationBodySchema,
  invitationTokenBodySchema,
} from '../invitations/invitation.schemas.js';
import { createPeopleService } from '../people/people.service.js';
import {
  archivePersonBodySchema,
  createPersonBodySchema,
  listPeopleQuerySchema,
  updateDistributionBodySchema,
  updatePersonBodySchema,
} from '../people/people.schemas.js';
import { asyncRoute } from './asyncRoute.js';
import {
  householdParamsSchema,
  uuidSchema,
} from './commonSchemas.js';
import { getAuthenticatedUserId, requireAuthenticationContext } from './requestAuth.js';

const personParamsSchema = householdParamsSchema
  .extend({ personId: uuidSchema })
  .strict();
const accessParamsSchema = householdParamsSchema
  .extend({ accessId: uuidSchema })
  .strict();
const categoryParamsSchema = householdParamsSchema
  .extend({ categoryId: uuidSchema })
  .strict();
const invitationParamsSchema = householdParamsSchema
  .extend({ invitationId: uuidSchema })
  .strict();
const emptyBodySchema = z.object({}).strict().default({});

const parseRequest = (request, schemas = {}) => ({
  ...(schemas.params ? { params: schemas.params.parse(request.params) } : {}),
  ...(schemas.query ? { query: schemas.query.parse(request.query) } : {}),
  ...(schemas.body ? { body: schemas.body.parse(request.body) } : {}),
});

const buildServices = ({ prisma, config, services, emailService, logger }) => ({
  households:
    services?.households ??
    createHouseholdsService({ prisma, defaults: config?.defaults }),
  people: services?.people ?? createPeopleService({ prisma }),
  access: services?.access ?? createAccessService({ prisma }),
  invitations:
    services?.invitations ??
    createInvitationsService({
      prisma,
      invitationTtlDays: config?.tokens?.invitationTtlDays ?? 7,
      emailService,
      logger,
    }),
  categories: services?.categories ?? createCategoriesService({ prisma }),
});

export const createHouseholdDomainRouter = ({
  prisma,
  config,
  authenticate,
  requireCsrf,
  services,
  emailService,
  logger,
}) => {
  if (!prisma && !services) {
    throw new TypeError('createHouseholdDomainRouter requires prisma or services.');
  }

  if (typeof requireCsrf !== 'function') {
    throw new TypeError(
      'createHouseholdDomainRouter requires the CSRF middleware for mutable routes.',
    );
  }

  const router = Router();
  const domain = buildServices({ prisma, config, services, emailService, logger });
  const requireAuthentication = authenticate ?? requireAuthenticationContext;

  router.post(
    '/invitations/preview',
    asyncRoute(async (request, response) => {
      const { body } = parseRequest(request, {
        body: invitationTokenBodySchema,
      });
      const preview = await domain.invitations.preview(body);
      response.set('Cache-Control', 'no-store');
      sendSuccess(response, preview);
    }),
  );

  router.use(['/invitations/accept', '/households'], requireAuthentication);

  router.post(
    '/invitations/accept',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { body } = parseRequest(request, {
        body: invitationTokenBodySchema,
      });
      const result = await domain.invitations.accept({
        actorUserId: getAuthenticatedUserId(request),
        token: body.token,
      });
      response.set('Cache-Control', 'no-store');
      sendSuccess(response, result);
    }),
  );

  router.get(
    '/households',
    asyncRoute(async (request, response) => {
      const { query } = parseRequest(request, {
        query: listHouseholdsQuerySchema,
      });
      const result = await domain.households.list({
        actorUserId: getAuthenticatedUserId(request),
        ...query,
      });
      sendSuccess(response, result.items, { meta: result.meta });
    }),
  );

  router.post(
    '/households',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { body } = parseRequest(request, {
        body: createHouseholdBodySchema,
      });
      const household = await domain.households.create({
        actorUserId: getAuthenticatedUserId(request),
        input: body,
      });
      sendSuccess(response, household, { statusCode: 201 });
    }),
  );

  router.get(
    '/households/:householdId',
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: householdParamsSchema,
      });
      const household = await domain.households.get({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, household);
    }),
  );

  router.patch(
    '/households/:householdId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: updateHouseholdBodySchema,
      });
      const household = await domain.households.update({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, household);
    }),
  );

  router.post(
    '/households/:householdId/archive',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: householdParamsSchema,
        body: emptyBodySchema,
      });
      const result = await domain.households.archive({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, result);
    }),
  );

  router.get(
    '/households/:householdId/people',
    asyncRoute(async (request, response) => {
      const { params, query } = parseRequest(request, {
        params: householdParamsSchema,
        query: listPeopleQuerySchema,
      });
      const result = await domain.people.list({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        ...query,
      });
      sendSuccess(response, result);
    }),
  );

  router.post(
    '/households/:householdId/people',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: createPersonBodySchema,
      });
      const person = await domain.people.create({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, person, { statusCode: 201 });
    }),
  );

  router.patch(
    '/households/:householdId/people/:personId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: personParamsSchema,
        body: updatePersonBodySchema,
      });
      const person = await domain.people.update({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, person);
    }),
  );

  router.put(
    '/households/:householdId/people/distribution',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: updateDistributionBodySchema,
      });
      const result = await domain.people.updateDistribution({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, result);
    }),
  );

  router.post(
    '/households/:householdId/people/:personId/archive',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: personParamsSchema,
        body: archivePersonBodySchema,
      });
      const person = await domain.people.archive({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, person);
    }),
  );

  router.get(
    '/households/:householdId/access',
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: householdParamsSchema,
      });
      const accesses = await domain.access.list({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, accesses);
    }),
  );

  router.patch(
    '/households/:householdId/access/:accessId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: accessParamsSchema,
        body: updateAccessBodySchema,
      });
      const access = await domain.access.update({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        role: body.role,
      });
      sendSuccess(response, access);
    }),
  );

  router.delete(
    '/households/:householdId/access/:accessId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: accessParamsSchema,
      });
      const access = await domain.access.revoke({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, access);
    }),
  );

  router.post(
    '/households/:householdId/ownership-transfer',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: transferOwnershipBodySchema,
      });
      const result = await domain.access.transferOwnership({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        ...body,
      });
      sendSuccess(response, result);
    }),
  );

  router.get(
    '/households/:householdId/invitations',
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: householdParamsSchema,
      });
      const invitations = await domain.invitations.list({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, invitations);
    }),
  );

  router.post(
    '/households/:householdId/invitations',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: createInvitationBodySchema,
      });
      const invitation = await domain.invitations.create({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      response.set('Cache-Control', 'no-store');
      sendSuccess(response, invitation, { statusCode: 201 });
    }),
  );

  router.delete(
    '/households/:householdId/invitations/:invitationId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: invitationParamsSchema,
      });
      const invitation = await domain.invitations.revoke({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, invitation);
    }),
  );

  router.get(
    '/households/:householdId/categories',
    asyncRoute(async (request, response) => {
      const { params, query } = parseRequest(request, {
        params: householdParamsSchema,
        query: listCategoriesQuerySchema,
      });
      const result = await domain.categories.list({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        ...query,
      });
      sendSuccess(response, result);
    }),
  );

  router.post(
    '/households/:householdId/categories',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: householdParamsSchema,
        body: createCategoryBodySchema,
      });
      const category = await domain.categories.create({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, category, { statusCode: 201 });
    }),
  );

  router.patch(
    '/households/:householdId/categories/:categoryId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params, body } = parseRequest(request, {
        params: categoryParamsSchema,
        body: updateCategoryBodySchema,
      });
      const category = await domain.categories.update({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
        input: body,
      });
      sendSuccess(response, category);
    }),
  );

  router.post(
    '/households/:householdId/categories/:categoryId/archive',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: categoryParamsSchema,
        body: emptyBodySchema,
      });
      const category = await domain.categories.archive({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, category);
    }),
  );

  router.delete(
    '/households/:householdId/categories/:categoryId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { params } = parseRequest(request, {
        params: categoryParamsSchema,
      });
      const result = await domain.categories.remove({
        actorUserId: getAuthenticatedUserId(request),
        ...params,
      });
      sendSuccess(response, result);
    }),
  );

  return router;
};
