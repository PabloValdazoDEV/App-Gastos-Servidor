import { describe, expect, it, vi } from 'vitest';

import { runReminderJob } from '../src/jobs/reminder.job.js';

function createPrismaFake(expenses) {
  const notifications = new Map();
  const deliveries = new Map();
  let notificationSequence = 0;
  let deliverySequence = 0;
  const notificationKey = (unique) =>
    `${unique.userId}:${unique.recurringExpenseId}:${unique.dueDate.toISOString()}:${unique.offsetDays}`;
  const deliveryKey = ({ notificationId, channel }) => `${notificationId}:${channel}`;

  return {
    recurringExpense: { findMany: vi.fn(async () => expenses) },
    notification: {
      findUnique: vi.fn(async ({ where }) =>
        notifications.get(
          notificationKey(where.userId_recurringExpenseId_dueDate_offsetDays),
        ) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = notificationKey(where.userId_recurringExpenseId_dueDate_offsetDays);
        const existing = notifications.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        notificationSequence += 1;
        const item = {
          id: `notification-${notificationSequence}`,
          ...create,
          user: { email: 'persona@example.com', pushSubscriptions: [] },
        };
        notifications.set(key, item);
        return item;
      }),
    },
    notificationDelivery: {
      findUnique: vi.fn(async ({ where }) =>
        deliveries.get(deliveryKey(where.notificationId_channel)) ?? null,
      ),
      upsert: vi.fn(async ({ where, create }) => {
        const key = deliveryKey(where.notificationId_channel);
        const existing = deliveries.get(key);
        if (existing) return existing;
        deliverySequence += 1;
        const notification = [...notifications.values()].find(
          (item) => item.id === create.notificationId,
        );
        const item = {
          id: `delivery-${deliverySequence}`,
          attempts: 0,
          status: 'PENDING',
          createdAt: new Date(),
          ...create,
          notification,
        };
        deliveries.set(key, item);
        return item;
      }),
      findMany: vi.fn(async () =>
        [...deliveries.values()].filter((item) =>
          ['PENDING', 'FAILED'].includes(item.status),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!where.id) return { count: 0 };
        const item = [...deliveries.values()].find(
          (candidate) =>
            candidate.id === where.id && where.status.in.includes(candidate.status),
        );
        if (!item) return { count: 0 };
        item.status = data.status;
        item.attempts += data.attempts.increment;
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const item = [...deliveries.values()].find(
          (candidate) => candidate.id === where.id,
        );
        Object.assign(item, data);
        return item;
      }),
    },
    state: { notifications, deliveries },
  };
}

describe('runReminderJob', () => {
  it('no crea ni envía dos veces el mismo recordatorio al repetirse el job', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const householdId = '00000000-0000-4000-8000-000000000002';
    const expenseId = '00000000-0000-4000-8000-000000000003';
    const expenses = [
      {
        id: expenseId,
        householdId,
        name: 'Seguro del coche',
        amountCents: 90_499,
        nextDueDate: new Date('2026-09-02T00:00:00.000Z'),
        remindersEnabled: true,
        isActive: true,
        archivedAt: null,
        reminderRules: [],
        household: {
          accesses: [
            {
              userId,
              isActive: true,
              revokedAt: null,
              user: {
                isActive: true,
                notificationPreference: {
                  inAppEnabled: true,
                  emailEnabled: false,
                  webPushEnabled: false,
                  defaultOffsets: [7],
                },
              },
            },
          ],
        },
      },
    ];
    const prisma = createPrismaFake(expenses);
    const deliver = vi.fn(async () => undefined);
    const config = { features: { email: false, webPush: false } };
    const now = new Date('2026-08-26T08:00:00.000Z');

    await runReminderJob({ prisma, config, now, adapters: { IN_APP: deliver } });
    await runReminderJob({ prisma, config, now, adapters: { IN_APP: deliver } });

    expect(prisma.state.notifications.size).toBe(1);
    expect(prisma.state.deliveries.size).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
