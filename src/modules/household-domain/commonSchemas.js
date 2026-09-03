import { z } from 'zod';

export const uuidSchema = z.string().uuid('Debe ser un UUID válido.');

export const emailSchema = z
  .string()
  .trim()
  .email('Debe ser un correo electrónico válido.')
  .max(320)
  .transform((email) => email.toLowerCase());

export const percentageBpsSchema = z
  .number()
  .int()
  .min(0)
  .max(10000);

export const moneyCentsSchema = z.number().int().min(0).max(2147483647);

const parseBooleanQuery = (value) => {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
};

export const booleanQuerySchema = z.preprocess(parseBooleanQuery, z.boolean());

export const paginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const householdParamsSchema = z
  .object({ householdId: uuidSchema })
  .strict();

export const isValidTimezone = (timezone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

export const isValidLocale = (locale) => {
  try {
    new Intl.Locale(locale);
    return true;
  } catch {
    return false;
  }
};

export const hasOwnFields = (value) => Object.keys(value).length > 0;

