import { z } from 'zod';

import {
  booleanQuerySchema,
  emailSchema,
  hasOwnFields,
  moneyCentsSchema,
  percentageBpsSchema,
  uuidSchema,
} from '../household-domain/commonSchemas.js';

const personFields = {
  name: z.string().trim().min(1).max(120),
  email: emailSchema.nullable().optional(),
  contributionBps: percentageBpsSchema.optional(),
  fixedContributionCents: moneyCentsSchema.nullable().optional(),
  isActive: z.boolean().optional(),
};

export const listPeopleQuerySchema = z
  .object({ includeArchived: booleanQuerySchema.default(false) })
  .strict();

export const createPersonBodySchema = z
  .object({
    ...personFields,
    contributionBps: percentageBpsSchema.default(0),
    isActive: z.boolean().default(false),
  })
  .strict();

export const updatePersonBodySchema = z
  .object(personFields)
  .strict()
  .refine(hasOwnFields, 'Debes indicar al menos un campo para actualizar.');

export const archivePersonBodySchema = z
  .object({ allowWithActivePersonalExpenses: z.literal(false).optional() })
  .strict()
  .default({});

const contributionUpdateSchema = z
  .object({
    personId: uuidSchema,
    isActive: z.boolean().optional(),
    contributionBps: percentageBpsSchema.optional(),
    fixedContributionCents: moneyCentsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (update) => Object.keys(update).some((key) => key !== 'personId'),
    'Cada persona necesita al menos un cambio.',
  );

export const updateDistributionBodySchema = z
  .object({
    contributionMode: z.enum(['PERCENTAGE', 'FIXED']).optional(),
    people: z.array(contributionUpdateSchema).min(1).max(100),
  })
  .strict()
  .superRefine((body, context) => {
    const ids = body.people.map((person) => person.personId);

    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['people'],
        message: 'Cada persona solo puede aparecer una vez.',
      });
    }
  });

