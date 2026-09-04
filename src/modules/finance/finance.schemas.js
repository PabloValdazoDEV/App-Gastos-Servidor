import { z } from 'zod';

import { toCivilDate } from '../../services/date.service.js';

const uuid = z.string().uuid('Debe ser un UUID válido.');
const cents = z.number().int().min(0).max(2_147_483_647);
const signedCents = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const bps = z.number().int().min(0).max(10_000);
const nonEmptyText = (maximum) => z.string().trim().min(1).max(maximum);
const optionalNotes = z.string().trim().max(2_000).nullable().optional();

const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Debe usar el formato YYYY-MM-DD.')
  .transform((value, context) => {
    try {
      return toCivilDate(value);
    } catch (error) {
      context.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

const expenseScope = z.enum(['HOUSEHOLD', 'PERSONAL']);
const expenseFrequency = z.enum([
  'WEEKLY',
  'MONTHLY',
  'BIMONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'YEARLY',
  'CUSTOM_MONTHS',
  'ONE_TIME',
]);

const scopeFields = {
  scope: expenseScope.default('HOUSEHOLD'),
  personalPersonId: uuid.nullable().optional(),
};

const updateScopeFields = {
  scope: expenseScope.optional(),
  personalPersonId: uuid.nullable().optional(),
};

function validateScope(body, context) {
  if (body.scope === 'PERSONAL' && !body.personalPersonId) {
    context.addIssue({
      code: 'custom',
      path: ['personalPersonId'],
      message: 'Selecciona la persona responsable del gasto personal.',
    });
  }
  if (body.scope === 'HOUSEHOLD' && body.personalPersonId) {
    context.addIssue({
      code: 'custom',
      path: ['personalPersonId'],
      message: 'Un gasto común no puede tener una persona asignada.',
    });
  }
}

const recurringBase = z.object({
  categoryId: uuid,
  name: nonEmptyText(120),
  amountCents: cents,
  ...scopeFields,
  frequency: expenseFrequency,
  intervalMonths: z.number().int().min(1).max(120).nullable().optional(),
  startDate: civilDate,
  endDate: civilDate.nullable().optional(),
  nextDueDate: civilDate,
  usualDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  safetyMarginOverrideBps: bps.nullable().optional(),
  remindersEnabled: z.boolean().default(true),
  notes: optionalNotes,
});

export const createRecurringExpenseSchema = recurringBase
  .strict()
  .superRefine((body, context) => {
    validateScope(body, context);
    if (body.frequency === 'CUSTOM_MONTHS' && !body.intervalMonths) {
      context.addIssue({
        code: 'custom',
        path: ['intervalMonths'],
        message: 'Indica cada cuántos meses se repite.',
      });
    }
    if (body.endDate && body.endDate < body.startDate) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'La fecha final no puede ser anterior a la inicial.',
      });
    }
  });

export const updateRecurringExpenseSchema = recurringBase
  .partial()
  .extend(updateScopeFields)
  .extend({ isActive: z.boolean().optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Indica algún dato para actualizar.');

export const listRecurringQuerySchema = z
  .object({
    includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    scope: expenseScope.optional(),
  })
  .strict();

export const registerPaymentSchema = z
  .object({
    dueDate: civilDate.optional(),
    expectedAmountCents: cents.optional(),
    actualAmountCents: cents.nullable().optional(),
    paymentDate: civilDate.nullable().optional(),
    status: z.enum(['PAID', 'SKIPPED']),
    nextAmountDecision: z
      .enum(['KEEP_PREVIOUS', 'UPDATE_NEXT_AMOUNT'])
      .default('KEEP_PREVIOUS'),
    nextExpectedAmountCents: cents.nullable().optional(),
    notes: optionalNotes,
  })
  .strict()
  .superRefine((body, context) => {
    if (body.status === 'PAID' && body.actualAmountCents == null) {
      context.addIssue({
        code: 'custom',
        path: ['actualAmountCents'],
        message: 'Indica el importe real pagado.',
      });
    }
    if (body.status === 'SKIPPED' && body.actualAmountCents != null) {
      context.addIssue({
        code: 'custom',
        path: ['actualAmountCents'],
        message: 'Un vencimiento omitido no admite importe real.',
      });
    }
    if (body.status === 'SKIPPED' && body.paymentDate != null) {
      context.addIssue({
        code: 'custom',
        path: ['paymentDate'],
        message: 'Un vencimiento omitido no admite fecha de pago.',
      });
    }
    if (
      body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT' &&
      body.status !== 'PAID'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextAmountDecision'],
        message: 'Solo un pago realizado puede actualizar el siguiente importe.',
      });
    }
    if (
      body.nextAmountDecision === 'UPDATE_NEXT_AMOUNT' &&
      body.nextExpectedAmountCents != null &&
      body.actualAmountCents != null &&
      body.nextExpectedAmountCents !== body.actualAmountCents
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextExpectedAmountCents'],
        message: 'El siguiente importe debe coincidir con el importe real pagado.',
      });
    }
    if (
      body.nextAmountDecision === 'KEEP_PREVIOUS' &&
      body.nextExpectedAmountCents != null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextExpectedAmountCents'],
        message: 'No indiques un siguiente importe al mantener el anterior.',
      });
    }
  });

// A historical payment is deliberately edited independently from the recurring
// expense. In particular, it must never move the next due date or silently
// change the amount expected for the next occurrence.
export const editPaymentSchema = z
  .object({
    status: z.enum(['PAID', 'SKIPPED']),
    actualAmountCents: cents.nullable(),
    paymentDate: civilDate.nullable(),
    notes: optionalNotes,
  })
  .strict()
  .superRefine((body, context) => {
    if (body.status === 'PAID' && body.actualAmountCents == null) {
      context.addIssue({
        code: 'custom',
        path: ['actualAmountCents'],
        message: 'Indica el importe real pagado.',
      });
    }
    if (body.status === 'PAID' && body.paymentDate == null) {
      context.addIssue({
        code: 'custom',
        path: ['paymentDate'],
        message: 'Indica la fecha de pago.',
      });
    }
    if (body.status === 'SKIPPED' && body.actualAmountCents != null) {
      context.addIssue({
        code: 'custom',
        path: ['actualAmountCents'],
        message: 'Un vencimiento omitido no admite importe real.',
      });
    }
    if (body.status === 'SKIPPED' && body.paymentDate != null) {
      context.addIssue({
        code: 'custom',
        path: ['paymentDate'],
        message: 'Un vencimiento omitido no admite fecha de pago.',
      });
    }
  });

const invoiceBase = z.object({
  categoryId: uuid,
  amountCents: cents,
  ...scopeFields,
  periodStart: civilDate,
  periodEnd: civilDate,
  invoiceDate: civilDate,
  chargeDate: civilDate.nullable().optional(),
  notes: optionalNotes,
});

export const createInvoiceSchema = invoiceBase
  .strict()
  .superRefine((body, context) => {
    validateScope(body, context);
    if (body.periodEnd < body.periodStart) {
      context.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'El fin del periodo no puede ser anterior al inicio.',
      });
    }
  });

export const updateInvoiceSchema = invoiceBase
  .partial()
  .extend(updateScopeFields)
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Indica algún dato para actualizar.');

export const invoiceQuerySchema = z
  .object({ categoryId: uuid.optional(), scope: expenseScope.optional() })
  .strict();

export const createOneTimeExpenseSchema = z
  .object({
    categoryId: uuid,
    name: nonEmptyText(120),
    amountCents: cents,
    ...scopeFields,
    expenseDate: civilDate,
    notes: optionalNotes,
  })
  .strict()
  .superRefine((body, context) => validateScope(body, context));

export const updateOneTimeExpenseSchema = createOneTimeExpenseSchema
  .partial()
  .extend(updateScopeFields)
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Indica algún dato para actualizar.');

export const oneTimeExpenseQuerySchema = z
  .object({ categoryId: uuid.optional(), scope: expenseScope.optional() })
  .strict();

const accountBase = z.object({
  name: nonEmptyText(120),
  scope: expenseScope.default('HOUSEHOLD'),
  personalPersonId: uuid.nullable().optional(),
  balanceCents: signedCents,
});

export const createAccountSchema = accountBase
  .strict()
  .superRefine((body, context) => validateScope(body, context));

export const updateAccountSchema = accountBase
  .partial()
  .extend(updateScopeFields)
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Indica algún dato para actualizar.')
  .superRefine((body, context) => {
    if (body.scope || Object.hasOwn(body, 'personalPersonId')) {
      validateScope({ scope: body.scope ?? 'HOUSEHOLD', personalPersonId: body.personalPersonId ?? null }, context);
    }
  });

const variableEntry = z
  .object({
    id: uuid.optional(),
    spentOn: civilDate,
    merchant: z.string().trim().max(120).nullable().optional(),
    amountCents: cents,
    notes: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict();

export const upsertVariableMonthSchema = z
  .object({
    categoryId: uuid,
    ...scopeFields,
    year: z.number().int().min(2000).max(2200),
    month: z.number().int().min(1).max(12),
    entryMode: z.enum(['DETAIL', 'SUMMARY']),
    summaryAmountCents: cents.nullable().optional(),
    isComplete: z.boolean().default(true),
    notes: optionalNotes,
    entries: z.array(variableEntry).max(1_000).optional(),
  })
  .strict()
  .superRefine((body, context) => {
    validateScope(body, context);
    if (body.entryMode === 'SUMMARY' && body.summaryAmountCents == null) {
      context.addIssue({
        code: 'custom',
        path: ['summaryAmountCents'],
        message: 'Indica el total mensual.',
      });
    }
    if (body.entryMode === 'SUMMARY' && body.entries?.length) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'El modo resumen no admite apuntes detallados.',
      });
    }
    if (body.entryMode === 'DETAIL' && body.summaryAmountCents != null) {
      context.addIssue({
        code: 'custom',
        path: ['summaryAmountCents'],
        message: 'El modo detallado calcula el total desde sus apuntes.',
      });
    }
  });

export const variableQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2200).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    categoryId: uuid.optional(),
    ownerKey: z.string().max(40).optional(),
  })
  .strict();

export const updateBalanceSchema = z
  .object({ balanceCents: signedCents })
  .strict();

export const calculationQuerySchema = z
  .object({
    date: civilDate.optional(),
    balanceCents: z.coerce.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  })
  .strict();

export const prepareMonthSchema = z
  .object({
    calculationDate: civilDate,
    confirmedBalanceCents: signedCents,
    confirmedPersonalBalances: z
      .array(
        z
          .object({
            personId: uuid,
            balanceCents: signedCents,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const planningQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2200).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  })
  .strict();

export const recoveryPreviewSchema = z
  .object({
    deficitCents: cents.refine((value) => value > 0, 'El déficit debe ser positivo.'),
    mode: z.enum(['TARGET_MONTHS', 'MAX_MONTHLY', 'RECOMMENDED']),
    targetMonths: z.number().int().min(1).max(120).nullable().optional(),
    maximumMonthlyCents: cents.nullable().optional(),
    startsOn: civilDate.optional(),
    monthlyPlanningId: uuid.nullable().optional(),
  })
  .strict();

export const updateRecoverySchema = z
  .object({ status: z.enum(['COMPLETED', 'CANCELLED']) })
  .strict();

export const calendarQuerySchema = z
  .object({
    view: z.enum(['MONTH', '30_DAYS', '90_DAYS', 'YEAR']).default('30_DAYS'),
    anchorDate: civilDate.optional(),
  })
  .strict();

export const financeParamsSchema = z
  .object({
    householdId: uuid,
    expenseId: uuid.optional(),
    invoiceId: uuid.optional(),
    documentId: uuid.optional(),
    variableMonthId: uuid.optional(),
    entryId: uuid.optional(),
    paymentId: uuid.optional(),
    accountId: uuid.optional(),
    recoveryPlanId: uuid.optional(),
    planningId: uuid.optional(),
  })
  .passthrough();
