import nodemailer from 'nodemailer';

import { businessToday } from '../services/businessClock.service.js';
import {
  addCalendarDays,
  compareCivilDates,
  differenceInCalendarDays,
  toCivilDate,
} from '../services/date.service.js';
import { formatCurrency } from '../services/money.service.js';

const DEFAULT_OFFSETS = Object.freeze([30, 7, 1]);
const DEFAULT_PREFERENCE = Object.freeze({
  inAppEnabled: true,
  emailEnabled: true,
  webPushEnabled: false,
  defaultOffsets: DEFAULT_OFFSETS,
});

function channelEnabled(channel, preference, config) {
  if (channel === 'IN_APP') return preference.inAppEnabled;
  if (channel === 'EMAIL') return preference.emailEnabled && config.features.email;
  if (channel === 'WEB_PUSH') {
    return preference.webPushEnabled && config.features.webPush;
  }
  return false;
}

function defaultChannels(preference, config) {
  return ['IN_APP', 'EMAIL', 'WEB_PUSH'].filter((channel) =>
    channelEnabled(channel, preference, config),
  );
}

// A personal expense is only visible to the user linked to its person.
function canReceiveExpenseReminder(expense, access) {
  if (expense.scope !== 'PERSONAL') return true;
  const linkedUserId = expense.personalPerson?.linkedUserId;
  return Boolean(linkedUserId) && linkedUserId === access.userId;
}

function dueDateIsWithinSchedule(expense) {
  if (expense.endDate && compareCivilDates(expense.nextDueDate, expense.endDate) > 0) {
    return false;
  }
  return true;
}

function formatReminderAmount(expense) {
  try {
    return formatCurrency(expense.amountCents, 'es-ES', expense.household?.currency ?? 'EUR');
  } catch {
    return formatCurrency(expense.amountCents);
  }
}

/*
 * Picks the most recent reminder threshold already reached for a due date.
 * The job may not run every day (server off at the scheduled hour), so an
 * exact "today + offset === dueDate" match would silently lose reminders.
 * With offsets [30, 7, 1] and 5 days left this returns 7: the 7-day reminder
 * is still owed, while the 30-day one is obsolete and is never sent late.
 */
function reachedThreshold(offsets, daysUntilDue) {
  return offsets
    .filter((offsetDays) => offsetDays >= daysUntilDue)
    .reduce((closest, offsetDays) => (closest === null || offsetDays < closest ? offsetDays : closest), null);
}

export function buildReminderCandidates(expenses, today, config) {
  const candidates = [];

  expenses.forEach((expense) => {
    if (!expense.remindersEnabled || !expense.isActive || expense.archivedAt) return;
    if (!dueDateIsWithinSchedule(expense)) return;

    const civilToday = businessToday(expense.household?.timezone ?? 'UTC', today);
    const daysUntilDue = differenceInCalendarDays(expense.nextDueDate, civilToday);
    if (daysUntilDue < 0) return;

    expense.household.accesses.forEach((access) => {
      if (!access.isActive || access.revokedAt || !access.user?.isActive) return;
      if (!canReceiveExpenseReminder(expense, access)) return;
      const preference = access.user.notificationPreference ?? DEFAULT_PREFERENCE;
      const explicitRules = expense.reminderRules.filter(
        (rule) => rule.userId === access.userId,
      );
      const rules = explicitRules.length
        ? explicitRules
            .filter(
              (rule) =>
                rule.enabled && channelEnabled(rule.channel, preference, config),
            )
            .map((rule) => ({ offsetDays: rule.offsetDays, channels: [rule.channel] }))
        : (preference.defaultOffsets ?? DEFAULT_OFFSETS).map((offsetDays) => ({
            offsetDays,
            channels: defaultChannels(preference, config),
          }));
      const grouped = new Map();
      rules.forEach((rule) => {
        const channels = grouped.get(rule.offsetDays) ?? new Set();
        rule.channels.forEach((channel) => channels.add(channel));
        grouped.set(rule.offsetDays, channels);
      });

      const activeOffsets = [...grouped.entries()]
        .filter(([, channels]) => channels.size > 0)
        .map(([offsetDays]) => offsetDays);
      const offsetDays = reachedThreshold(activeOffsets, daysUntilDue);
      if (offsetDays === null) return;

      const channels = grouped.get(offsetDays);
      const dayLabel = daysUntilDue === 1 ? '1 día' : `${daysUntilDue} días`;
      candidates.push({
        userId: access.userId,
        householdId: expense.householdId,
        recurringExpenseId: expense.id,
        dueDate: expense.nextDueDate,
        offsetDays,
        title: daysUntilDue === 0 ? `${expense.name} vence hoy` : `${expense.name} vence en ${dayLabel}`,
        message: `Importe previsto: ${formatReminderAmount(expense)}.`,
        relatedPath: `/gastos/recurrentes/${expense.id}`,
        channels: [...channels],
      });
    });
  });

  return candidates;
}

export async function createDueNotifications({ prisma, config, today = new Date() }) {
  const expenses = await prisma.recurringExpense.findMany({
    where: {
      remindersEnabled: true,
      isActive: true,
      archivedAt: null,
      // One day of slack: "today" is resolved per household timezone below.
      nextDueDate: {
        gte: addCalendarDays(toCivilDate(today), -1),
        lte: addCalendarDays(today, 366),
      },
    },
    include: {
      reminderRules: true,
      personalPerson: { select: { linkedUserId: true } },
      household: {
        include: {
          accesses: {
            where: { isActive: true, revokedAt: null },
            include: {
              user: { include: { notificationPreference: true } },
            },
          },
        },
      },
    },
  });
  const candidates = buildReminderCandidates(expenses, today, config);
  let created = 0;
  let deliveriesCreated = 0;

  for (const candidate of candidates) {
    const unique = {
      userId: candidate.userId,
      recurringExpenseId: candidate.recurringExpenseId,
      dueDate: candidate.dueDate,
      offsetDays: candidate.offsetDays,
    };
    const existing = await prisma.notification.findUnique({
      where: { userId_recurringExpenseId_dueDate_offsetDays: unique },
    });
    // A reminder already created keeps its original text; later runs only
    // make sure its deliveries exist (idempotent catch-up).
    const notification = await prisma.notification.upsert({
      where: { userId_recurringExpenseId_dueDate_offsetDays: unique },
      update: {},
      create: {
        householdId: candidate.householdId,
        ...unique,
        title: candidate.title,
        message: candidate.message,
        relatedPath: candidate.relatedPath,
      },
    });
    if (!existing) created += 1;

    for (const channel of candidate.channels) {
      const currentDelivery = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: notification.id, channel } },
      });
      await prisma.notificationDelivery.upsert({
        where: { notificationId_channel: { notificationId: notification.id, channel } },
        update: {},
        create: { notificationId: notification.id, channel },
      });
      if (!currentDelivery) deliveriesCreated += 1;
    }
  }

  return { candidates: candidates.length, created, deliveriesCreated };
}

export async function createDeliveryAdapters(config) {
  const adapters = {
    IN_APP: async () => undefined,
  };

  if (config.features.email) {
    const transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: { user: config.email.user, pass: config.email.password },
    });
    adapters.EMAIL = async (delivery) =>
      transporter.sendMail({
        from: `"${config.email.fromName}" <${config.email.fromAddress}>`,
        to: delivery.notification.user.email,
        subject: delivery.notification.title,
        text: `${delivery.notification.message}\n\n${config.app.clientUrl}${delivery.notification.relatedPath ?? '/notificaciones'}`,
      });
  }

  if (config.features.webPush) {
    const webPush = (await import('web-push')).default;
    webPush.setVapidDetails(
      config.webPush.subject,
      config.webPush.publicKey,
      config.webPush.privateKey,
    );
    adapters.WEB_PUSH = async (delivery) => {
      const payload = JSON.stringify({
        title: delivery.notification.title,
        body: delivery.notification.message,
        path: delivery.notification.relatedPath,
      });
      const results = await Promise.allSettled(
        delivery.notification.user.pushSubscriptions.map((subscription) =>
          webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
          ),
        ),
      );
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('No se pudieron entregar todas las notificaciones web push.');
      }
    };
  }

  return adapters;
}

export async function processPendingDeliveries({
  prisma,
  adapters,
  now = new Date(),
  workerId = `reminder-${process.pid}`,
  limit = 100,
}) {
  const staleLockBefore = new Date(now.getTime() - 15 * 60_000);
  await prisma.notificationDelivery.updateMany({
    where: {
      status: 'PROCESSING',
      lockedAt: { lt: staleLockBefore },
    },
    data: {
      status: 'FAILED',
      errorCode: 'STALE_DELIVERY_LOCK',
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
    },
  });
  const pending = await prisma.notificationDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    include: {
      notification: {
        include: { user: { include: { pushSubscriptions: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const delivery of pending) {
    const claimed = await prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, status: { in: ['PENDING', 'FAILED'] } },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lockedAt: now,
        lockedBy: workerId,
      },
    });
    if (!claimed.count) continue;
    const adapter = adapters[delivery.channel];
    if (!adapter) {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SKIPPED',
          errorCode: 'CHANNEL_DISABLED',
          lockedAt: null,
          lockedBy: null,
        },
      });
      skipped += 1;
      continue;
    }
    try {
      await adapter(delivery);
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          errorCode: null,
          lockedAt: null,
          lockedBy: null,
        },
      });
      sent += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const retryMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          errorCode: error?.code?.toString().slice(0, 120) || 'DELIVERY_FAILED',
          nextAttemptAt: new Date(now.getTime() + retryMinutes * 60_000),
          lockedAt: null,
          lockedBy: null,
        },
      });
      failed += 1;
    }
  }

  return { selected: pending.length, sent, failed, skipped };
}

export async function runReminderJob({ prisma, config, now = new Date(), adapters }) {
  const generation = await createDueNotifications({ prisma, config, today: now });
  const deliveryAdapters = adapters ?? (await createDeliveryAdapters(config));
  const delivery = await processPendingDeliveries({
    prisma,
    adapters: deliveryAdapters,
    now,
  });
  return { generation, delivery };
}
