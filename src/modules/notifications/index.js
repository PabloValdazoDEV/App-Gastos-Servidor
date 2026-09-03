import express from 'express';

import { sha256 } from '../../utils/crypto.js';
import { sendSuccess } from '../../utils/httpResponses.js';
import { requireHouseholdRole } from '../households/authorization.js';
import { asyncRoute } from '../household-domain/asyncRoute.js';
import { createAuditLog } from '../household-domain/audit.js';
import { createDomainError } from '../household-domain/domainError.js';
import {
  notificationListQuerySchema,
  notificationParamsSchema,
  preferenceBodySchema,
  pushSubscriptionBodySchema,
  reminderRulesBodySchema,
} from './notification.schemas.js';

const DEFAULT_PREFERENCE = Object.freeze({
  inAppEnabled: true,
  emailEnabled: true,
  webPushEnabled: false,
  defaultOffsets: [30, 7, 1],
});

export const createNotificationRouter = ({ prisma, authenticate, requireCsrf }) => {
  if (!prisma || !authenticate || !requireCsrf) {
    throw new TypeError(
      'createNotificationRouter requiere prisma, authenticate y requireCsrf.',
    );
  }

  const router = express.Router();
  router.use(
    [
      '/notifications',
      '/notification-preferences',
      '/households/:householdId/recurring-expenses/:expenseId/reminder-rules',
      '/push-subscriptions',
    ],
    authenticate,
  );

  router.get(
    '/notifications',
    asyncRoute(async (request, response) => {
      const query = notificationListQuerySchema.parse(request.query);
      const where = {
        userId: request.auth.userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
      };
      const [items, total, unread] = await Promise.all([
        prisma.notification.findMany({
          where,
          include: {
            deliveries: true,
            recurringExpense: { select: { id: true, name: true, amountCents: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId: request.auth.userId, readAt: null } }),
      ]);
      return sendSuccess(response, items, {
        meta: { page: query.page, pageSize: query.pageSize, total, unread },
      });
    }),
  );

  router.patch(
    '/notifications/read-all',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const result = await prisma.notification.updateMany({
        where: { userId: request.auth.userId, readAt: null },
        data: { readAt: new Date() },
      });
      return sendSuccess(response, { updated: result.count });
    }),
  );

  router.patch(
    '/notifications/:notificationId/read',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { notificationId } = notificationParamsSchema.parse(request.params);
      const item = await prisma.notification.findFirst({
        where: { id: notificationId, userId: request.auth.userId },
      });
      if (!item) {
        throw createDomainError(404, 'NOTIFICATION_NOT_FOUND', 'No se encontró la notificación.');
      }
      return sendSuccess(
        response,
        await prisma.notification.update({
          where: { id: notificationId },
          data: { readAt: item.readAt ?? new Date() },
        }),
      );
    }),
  );

  router.get(
    '/notification-preferences',
    asyncRoute(async (request, response) => {
      const preferences = await prisma.notificationPreference.upsert({
        where: { userId: request.auth.userId },
        update: {},
        create: { userId: request.auth.userId, ...DEFAULT_PREFERENCE },
      });
      return sendSuccess(response, preferences);
    }),
  );

  router.patch(
    '/notification-preferences',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const body = preferenceBodySchema.parse(request.body);
      const preferences = await prisma.$transaction(async (database) => {
        const item = await database.notificationPreference.upsert({
          where: { userId: request.auth.userId },
          update: body,
          create: { userId: request.auth.userId, ...DEFAULT_PREFERENCE, ...body },
        });
        await createAuditLog(database, {
          actorUserId: request.auth.userId,
          action: 'NOTIFICATION_PREFERENCE_CHANGED',
          resourceType: 'NotificationPreference',
          resourceId: item.id,
        });
        return item;
      });
      return sendSuccess(response, preferences);
    }),
  );

  router.get(
    '/households/:householdId/recurring-expenses/:expenseId/reminder-rules',
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = notificationParamsSchema.parse(request.params);
      await requireHouseholdRole(prisma, {
        householdId,
        userId: request.auth.userId,
      });
      const expense = await prisma.recurringExpense.findFirst({
        where: { id: expenseId, householdId },
      });
      if (!expense) {
        throw createDomainError(
          404,
          'RECURRING_EXPENSE_NOT_FOUND',
          'No se encontró el gasto recurrente.',
        );
      }
      const rules = await prisma.reminderRule.findMany({
        where: { userId: request.auth.userId, recurringExpenseId: expenseId },
        orderBy: [{ offsetDays: 'desc' }, { channel: 'asc' }],
      });
      return sendSuccess(response, rules);
    }),
  );

  router.put(
    '/households/:householdId/recurring-expenses/:expenseId/reminder-rules',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { householdId, expenseId } = notificationParamsSchema.parse(request.params);
      const body = reminderRulesBodySchema.parse(request.body);
      await requireHouseholdRole(prisma, {
        householdId,
        userId: request.auth.userId,
      });
      const expense = await prisma.recurringExpense.findFirst({
        where: { id: expenseId, householdId },
      });
      if (!expense) {
        throw createDomainError(
          404,
          'RECURRING_EXPENSE_NOT_FOUND',
          'No se encontró el gasto recurrente.',
        );
      }
      const rules = await prisma.$transaction(async (database) => {
        await database.reminderRule.deleteMany({
          where: { userId: request.auth.userId, recurringExpenseId: expenseId },
        });
        if (body.rules.length) {
          await database.reminderRule.createMany({
            data: body.rules.map((rule) => ({
              userId: request.auth.userId,
              recurringExpenseId: expenseId,
              ...rule,
            })),
          });
        }
        return database.reminderRule.findMany({
          where: { userId: request.auth.userId, recurringExpenseId: expenseId },
          orderBy: [{ offsetDays: 'desc' }, { channel: 'asc' }],
        });
      });
      return sendSuccess(response, rules);
    }),
  );

  router.get(
    '/push-subscriptions',
    asyncRoute(async (request, response) => {
      const items = await prisma.pushSubscription.findMany({
        where: { userId: request.auth.userId },
        select: { id: true, endpoint: true, expiresAt: true, userAgent: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return sendSuccess(response, items);
    }),
  );

  router.post(
    '/push-subscriptions',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const body = pushSubscriptionBodySchema.parse(request.body);
      const endpointHash = sha256(body.endpoint);
      const item = await prisma.pushSubscription.upsert({
        where: { endpointHash },
        update: {
          userId: request.auth.userId,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          expiresAt: body.expirationTime ? new Date(body.expirationTime) : null,
          userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
        },
        create: {
          userId: request.auth.userId,
          endpointHash,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          expiresAt: body.expirationTime ? new Date(body.expirationTime) : null,
          userAgent: request.get('user-agent')?.slice(0, 512) ?? null,
        },
      });
      return sendSuccess(response, { id: item.id }, { statusCode: 201 });
    }),
  );

  router.delete(
    '/push-subscriptions/:subscriptionId',
    requireCsrf,
    asyncRoute(async (request, response) => {
      const { subscriptionId } = notificationParamsSchema.parse(request.params);
      const result = await prisma.pushSubscription.deleteMany({
        where: { id: subscriptionId, userId: request.auth.userId },
      });
      if (!result.count) {
        throw createDomainError(404, 'PUSH_SUBSCRIPTION_NOT_FOUND', 'No se encontró la suscripción.');
      }
      return sendSuccess(response, { id: subscriptionId, deleted: true });
    }),
  );

  return router;
};
