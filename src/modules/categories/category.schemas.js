import { z } from 'zod';

import {
  booleanQuerySchema,
  hasOwnFields,
  percentageBpsSchema,
} from '../household-domain/commonSchemas.js';

const categoryNameSchema = z.string().trim().min(1).max(80);
const categorySlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const iconSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((color) => color.toUpperCase());

export const listCategoriesQuerySchema = z
  .object({ includeArchived: booleanQuerySchema.default(false) })
  .strict();

export const createCategoryBodySchema = z
  .object({
    name: categoryNameSchema,
    slug: categorySlugSchema.optional(),
    icon: iconSchema,
    color: colorSchema,
    safetyMarginBps: percentageBpsSchema.nullable().optional(),
  })
  .strict();

export const updateCategoryBodySchema = z
  .object({
    name: categoryNameSchema.optional(),
    slug: categorySlugSchema.optional(),
    icon: iconSchema.optional(),
    color: colorSchema.optional(),
    safetyMarginBps: percentageBpsSchema.nullable().optional(),
  })
  .strict()
  .refine(hasOwnFields, 'Debes indicar al menos un campo para actualizar.');

