import { z } from 'zod';

export const notificationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    unreadOnly: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  })
  .strict();

export const notificationParamsSchema = z
  .object({
    notificationId: z.string().uuid().optional(),
    householdId: z.string().uuid().optional(),
    expenseId: z.string().uuid().optional(),
    subscriptionId: z.string().uuid().optional(),
  })
  .passthrough();

export const preferenceBodySchema = z
  .object({
    inAppEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    webPushEnabled: z.boolean().optional(),
    defaultOffsets: z
      .array(z.number().int().min(0).max(365))
      .min(1)
      .max(20)
      .transform((items) => [...new Set(items)].sort((left, right) => right - left))
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Indica alguna preferencia.');

export const reminderRulesBodySchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            offsetDays: z.number().int().min(0).max(365),
            channel: z.enum(['IN_APP', 'EMAIL', 'WEB_PUSH']),
            enabled: z.boolean().default(true),
          })
          .strict(),
      )
      .max(60),
  })
  .strict();

export const pushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().url().max(4_096),
    expirationTime: z.number().int().positive().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(4_096),
        auth: z.string().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();

