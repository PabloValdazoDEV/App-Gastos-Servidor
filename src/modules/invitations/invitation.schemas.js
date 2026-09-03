import { z } from 'zod';

import { emailSchema, uuidSchema } from '../household-domain/commonSchemas.js';

export const createInvitationBodySchema = z
  .object({
    email: emailSchema.optional(),
    householdPersonId: uuidSchema.optional(),
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
  })
  .strict()
  .refine(
    (body) => body.email !== undefined || body.householdPersonId !== undefined,
    {
      path: ['email'],
      message: 'Indica un correo o una persona del hogar.',
    },
  );

export const invitationTokenBodySchema = z
  .object({ token: z.string().min(32).max(512) })
  .strict();

