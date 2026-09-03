import { z } from 'zod';

const normalizedEmail = z
  .string()
  .trim()
  .email('Introduce un correo electrónico válido.')
  .max(320)
  .transform((value) => value.toLowerCase());

const password = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres.')
  .max(1_024, 'La contraseña es demasiado larga.')
  .regex(/[a-z]/, 'La contraseña debe incluir una minúscula.')
  .regex(/[A-Z]/, 'La contraseña debe incluir una mayúscula.')
  .regex(/[0-9]/, 'La contraseña debe incluir un número.')
  .regex(/[^A-Za-z0-9]/, 'La contraseña debe incluir un carácter especial.');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: normalizedEmail,
    password,
    privacyPolicyAcknowledged: z.literal(true, {
      error:
        'Debes confirmar que has leído la política de privacidad y que has sido informado para registrarte.',
    }),
    privacyPolicyVersion: z
      .string({
        error: 'Indica la versión de la política de privacidad que has leído.',
      })
      .trim()
      .min(1, 'Indica la versión de la política de privacidad que has leído.')
      .max(120),
  })
  .strict();

export const loginSchema = z
  .object({
    email: normalizedEmail,
    password: z.string().min(1).max(1_024),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({ email: normalizedEmail })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(32).max(512),
    password,
  })
  .strict();

export const googleCallbackSchema = z
  .object({
    code: z.string().min(1).max(4_096).optional(),
    state: z.string().min(16).max(512).optional(),
    error: z.string().min(1).max(256).optional(),
  })
  .refine((value) => value.error || (value.code && value.state), {
    message: 'La respuesta de Google no está completa.',
  });

export const googleStartSchema = z
  .object({
    privacyPolicyAcknowledged: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    privacyPolicyVersion: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const googleLinkSchema = z
  .object({
    email: normalizedEmail.optional(),
    password: z.string().min(1).max(1_024),
  })
  .strict();

export const sessionParamsSchema = z.object({
  sessionId: z.string().uuid(),
});

export { normalizedEmail, password };
