import { z } from 'zod';

import {
  booleanQuerySchema,
  emailSchema,
  hasOwnFields,
  isValidLocale,
  isValidTimezone,
  moneyCentsSchema,
  paginationQuerySchema,
  percentageBpsSchema,
} from '../household-domain/commonSchemas.js';

const contributionModeSchema = z.enum(['PERCENTAGE', 'FIXED']);
const nameSchema = z.string().trim().min(1).max(120);
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimezone, 'Debe ser una zona horaria IANA válida.');
const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .refine(isValidLocale, 'Debe ser un locale BCP 47 válido.');

const initialPersonSchema = z
  .object({
    name: nameSchema,
    email: emailSchema.optional(),
    contributionBps: percentageBpsSchema.default(0),
    fixedContributionCents: moneyCentsSchema.nullable().optional(),
    linkCurrentUser: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict();

export const createHouseholdBodySchema = z
  .object({
    name: nameSchema,
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    timezone: timezoneSchema.optional(),
    locale: localeSchema.optional(),
    contributionMode: contributionModeSchema.default('PERCENTAGE'),
    safetyMarginBps: percentageBpsSchema.optional(),
    contributionDay: z.number().int().min(1).max(31).optional(),
    currentBalanceCents: moneyCentsSchema.default(0),
    people: z.array(initialPersonSchema).max(30).default([]),
  })
  .strict()
  .superRefine((body, context) => {
    const linkedPeople = body.people.filter((person) => person.linkCurrentUser);

    if (linkedPeople.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['people'],
        message: 'Solo una persona puede vincularse al usuario creador.',
      });
    }

    const emails = body.people
      .map((person) => person.email)
      .filter((email) => email !== undefined);

    if (new Set(emails).size !== emails.length) {
      context.addIssue({
        code: 'custom',
        path: ['people'],
        message: 'No puede haber correos duplicados entre las personas iniciales.',
      });
    }
  });

export const updateHouseholdBodySchema = z
  .object({
    name: nameSchema.optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    timezone: timezoneSchema.optional(),
    locale: localeSchema.optional(),
    contributionMode: contributionModeSchema.optional(),
    safetyMarginBps: percentageBpsSchema.optional(),
    contributionDay: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .refine(hasOwnFields, 'Debes indicar al menos un campo para actualizar.');

export const listHouseholdsQuerySchema = paginationQuerySchema
  .extend({ includeArchived: booleanQuerySchema.default(false) })
  .strict();

export const transferOwnershipBodySchema = z
  .object({ newOwnerUserId: z.string().uuid() })
  .strict();

