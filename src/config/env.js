import { z } from 'zod';

const EMPTY_STRING = /^\s*$/;
const TOKEN_TTL = /^\d+(?:ms|s|m|h|d)$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const emptyToUndefined = (value) => {
  if (typeof value === 'string' && EMPTY_STRING.test(value)) {
    return undefined;
  }

  return value;
};

const optionalString = (schema = z.string()) =>
  z.preprocess(emptyToUndefined, schema.optional());

const requiredSecret = z
  .string()
  .refine((value) => value.trim().length >= 32, {
    message: 'must contain at least 32 non-whitespace characters',
  });

const optionalSecret = optionalString(
  z.string().refine((value) => value.trim().length >= 32, {
    message: 'must contain at least 32 non-whitespace characters',
  }),
);

const envBoolean = (defaultValue) =>
  z.preprocess((value) => {
    const normalized = emptyToUndefined(value);

    if (normalized === undefined) {
      return defaultValue;
    }

    if (typeof normalized === 'boolean') {
      return normalized;
    }

    if (typeof normalized === 'string') {
      if (normalized.toLowerCase() === 'true') return true;
      if (normalized.toLowerCase() === 'false') return false;
    }

    return normalized;
  }, z.boolean());

const envInteger = (schema, defaultValue) =>
  z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    return normalized === undefined ? defaultValue : normalized;
  }, z.coerce.number().int().pipe(schema));

const envNumber = (schema, defaultValue) =>
  z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    return normalized === undefined ? defaultValue : normalized;
  }, z.coerce.number().pipe(schema));

const tryParseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const httpUrl = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const parsedUrl = tryParseUrl(value);

    if (!parsedUrl) return;

    const { protocol } = parsedUrl;

    if (protocol !== 'http:' && protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'must use http or https',
      });
    }
  });

const httpOrigin = httpUrl
  .superRefine((value, context) => {
    const url = tryParseUrl(value);

    if (!url) return;

    const isOriginOnly =
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === '';

    if (!isOriginOnly) {
      context.addIssue({
        code: 'custom',
        message: 'must be an origin without a path, credentials, query, or fragment',
      });
    }
  })
  .transform((value) => tryParseUrl(value)?.origin ?? value);

const clientOrigins = z
  .preprocess((value) => {
    if (typeof value !== 'string') return value;

    return value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }, z.array(httpOrigin).min(1, 'must contain at least one origin'))
  .transform((origins) => [...new Set(origins)]);

const postgresUrl = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const parsedUrl = tryParseUrl(value);

    if (!parsedUrl) return;

    const { protocol } = parsedUrl;

    if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
      context.addIssue({
        code: 'custom',
        message: 'must use the postgresql protocol',
      });
    }
  });

const timezone = z.string().trim().superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    context.addIssue({ code: 'custom', message: 'must be a valid IANA time zone' });
  }
});

const locale = z.string().trim().superRefine((value, context) => {
  try {
    new Intl.Locale(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'must be a valid locale' });
  }
});

const isoDate = z
  .string()
  .trim()
  .regex(ISO_DATE, 'must use YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);

    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, 'must be a valid calendar date');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: envInteger(z.number().min(1).max(65_535), 3000),
    APP_NAME: z.string().trim().min(1).default('BudgetApp'),
    SERVER_URL: httpOrigin.default('http://localhost:3000'),
    CLIENT_URL: httpOrigin.default('http://localhost:5173'),

    DATABASE_URL: postgresUrl,
    CLIENT_ORIGINS: clientOrigins,

    JWT_ACCESS_SECRET: requiredSecret,
    JWT_REFRESH_SECRET: requiredSecret,
    JWT_ACCESS_TTL: z.string().trim().regex(TOKEN_TTL).default('15m'),
    JWT_REFRESH_TTL_DAYS: envInteger(z.number().min(1).max(365), 30),

    AUTH_COOKIE_NAME: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
      .default('access_token'),
    REFRESH_COOKIE_NAME: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
      .default('refresh_token'),
    COOKIE_DOMAIN: optionalString(z.string().trim().min(1)),
    COOKIE_SECURE: envBoolean(false),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    CSRF_SECRET: requiredSecret,
    CSRF_COOKIE_NAME: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
      .default('csrf_token'),
    BCRYPT_ROUNDS: envInteger(z.number().min(8).max(15), 12),

    GOOGLE_AUTH_ENABLED: envBoolean(false),
    EMAIL_ENABLED: envBoolean(false),
    WEB_PUSH_ENABLED: envBoolean(false),

    GOOGLE_CLIENT_ID: optionalString(z.string().trim().min(1)),
    GOOGLE_CLIENT_SECRET: optionalString(z.string().min(1)),
    GOOGLE_CALLBACK_URL: httpUrl.default(
      'http://localhost:3000/api/auth/google/callback',
    ),

    SMTP_HOST: optionalString(z.string().trim().min(1)),
    SMTP_PORT: envInteger(z.number().min(1).max(65_535), 587),
    SMTP_SECURE: envBoolean(false),
    SMTP_USER: optionalString(z.string().min(1)),
    SMTP_PASS: optionalString(z.string().min(1)),
    MAIL_FROM_NAME: z.string().trim().min(1).default('BudgetApp'),
    MAIL_FROM_ADDRESS: z.string().trim().email().default('no-reply@example.com'),

    VAPID_PUBLIC_KEY: optionalString(z.string().trim().min(1)),
    VAPID_PRIVATE_KEY: optionalString(z.string().trim().min(1)),
    VAPID_SUBJECT: z
      .string()
      .trim()
      .refine(
        (value) => value.startsWith('mailto:') || value.startsWith('https://'),
        'must start with mailto: or https://',
      )
      .default('mailto:admin@example.com'),

    REMINDER_JOB_ENABLED: envBoolean(false),
    REMINDER_JOB_CRON: z.string().trim().min(1).default('0 8 * * *'),
    CRON_SECRET: optionalSecret,

    RATE_LIMIT_WINDOW_MS: envInteger(z.number().min(1), 900_000),
    RATE_LIMIT_MAX: envInteger(z.number().min(1), 300),
    AUTH_RATE_LIMIT_WINDOW_MS: envInteger(z.number().min(1), 900_000),
    AUTH_RATE_LIMIT_MAX: envInteger(z.number().min(1), 10),
    TRUST_PROXY_HOPS: envInteger(z.number().min(0).max(10), 0),

    PASSWORD_RESET_TTL_MINUTES: envInteger(z.number().min(1).max(1_440), 30),
    INVITATION_TTL_DAYS: envInteger(z.number().min(1).max(365), 7),

    DEFAULT_TIMEZONE: timezone.default('Europe/Madrid'),
    DEFAULT_LOCALE: locale.default('es-ES'),
    DEFAULT_CURRENCY: z.string().trim().regex(CURRENCY_CODE).default('EUR'),
    DEFAULT_SAFETY_MARGIN_PERCENT: envNumber(z.number().min(0).max(100), 10),
    DEFAULT_CONTRIBUTION_DAY: envInteger(z.number().min(1).max(28), 1),

    PRIVACY_POLICY_VERSION: optionalString(
      z.string().trim().min(1).max(120),
    ),
    PRIVACY_POLICY_EFFECTIVE_DATE: optionalString(isoDate),
    PRIVACY_CONTROLLER_NAME: optionalString(
      z.string().trim().min(1).max(200),
    ),
    PRIVACY_CONTROLLER_CONTACT_EMAIL: optionalString(
      z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    ),
    PRIVACY_CONTROLLER_ADDRESS: optionalString(
      z.string().trim().min(1).max(1_000),
    ),
    PRIVACY_DPO_EMAIL: optionalString(
      z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    ),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent'])
      .default('debug'),
  })
  .superRefine((environment, context) => {
    const requireFeatureValue = (enabled, key, value) => {
      if (enabled && value === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `is required when its feature is enabled`,
        });
      }
    };

    requireFeatureValue(
      environment.GOOGLE_AUTH_ENABLED,
      'GOOGLE_CLIENT_ID',
      environment.GOOGLE_CLIENT_ID,
    );
    requireFeatureValue(
      environment.GOOGLE_AUTH_ENABLED,
      'GOOGLE_CLIENT_SECRET',
      environment.GOOGLE_CLIENT_SECRET,
    );

    requireFeatureValue(environment.EMAIL_ENABLED, 'SMTP_HOST', environment.SMTP_HOST);
    requireFeatureValue(environment.EMAIL_ENABLED, 'SMTP_USER', environment.SMTP_USER);
    requireFeatureValue(environment.EMAIL_ENABLED, 'SMTP_PASS', environment.SMTP_PASS);

    requireFeatureValue(
      environment.WEB_PUSH_ENABLED,
      'VAPID_PUBLIC_KEY',
      environment.VAPID_PUBLIC_KEY,
    );
    requireFeatureValue(
      environment.WEB_PUSH_ENABLED,
      'VAPID_PRIVATE_KEY',
      environment.VAPID_PRIVATE_KEY,
    );

    if (
      environment.COOKIE_SAME_SITE === 'none' &&
      environment.COOKIE_SECURE === false
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when COOKIE_SAME_SITE is none',
      });
    }

    if (!environment.CLIENT_ORIGINS.includes(environment.CLIENT_URL)) {
      context.addIssue({
        code: 'custom',
        path: ['CLIENT_ORIGINS'],
        message: 'must include CLIENT_URL',
      });
    }

    const securitySecrets = new Set([
      environment.JWT_ACCESS_SECRET,
      environment.JWT_REFRESH_SECRET,
      environment.CSRF_SECRET,
    ]);

    if (securitySecrets.size !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT and CSRF secrets must all be different',
      });
    }

    const cookieNames = new Set([
      environment.AUTH_COOKIE_NAME,
      environment.REFRESH_COOKIE_NAME,
      environment.CSRF_COOKIE_NAME,
    ]);

    if (cookieNames.size !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_NAME'],
        message: 'authentication cookie names must all be different',
      });
    }

    if (environment.NODE_ENV === 'production' && !environment.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
  });

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }

  return value;
};

const formatEnvironmentIssues = (issues, source) => {
  const messages = issues.map((issue) => {
    const variable = String(issue.path[0] ?? 'environment');
    const originalValue = source[variable];
    const isMissing =
      originalValue === undefined ||
      (typeof originalValue === 'string' && EMPTY_STRING.test(originalValue));

    if (isMissing) {
      return `Missing required environment variable: ${variable}`;
    }

    return `Invalid environment variable ${variable}: ${issue.message}`;
  });

  return [...new Set(messages)];
};

export class EnvironmentValidationError extends Error {
  constructor(messages) {
    super(`Environment validation failed:\n- ${messages.join('\n- ')}`);
    this.name = 'EnvironmentValidationError';
    this.variables = messages;
  }
}

export const loadEnv = (source = process.env) => {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentValidationError(
      formatEnvironmentIssues(result.error.issues, source),
    );
  }

  const environment = result.data;
  const privacyConfigured = Boolean(
    environment.PRIVACY_POLICY_VERSION &&
      environment.PRIVACY_POLICY_EFFECTIVE_DATE &&
      environment.PRIVACY_CONTROLLER_NAME &&
      environment.PRIVACY_CONTROLLER_CONTACT_EMAIL,
  );

  return deepFreeze({
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    app: {
      name: environment.APP_NAME,
      serverUrl: environment.SERVER_URL,
      clientUrl: environment.CLIENT_URL,
    },
    database: {
      url: environment.DATABASE_URL,
    },
    cors: {
      origins: environment.CLIENT_ORIGINS,
    },
    jwt: {
      accessSecret: environment.JWT_ACCESS_SECRET,
      refreshSecret: environment.JWT_REFRESH_SECRET,
      accessTtl: environment.JWT_ACCESS_TTL,
      refreshTtlDays: environment.JWT_REFRESH_TTL_DAYS,
    },
    cookies: {
      authName: environment.AUTH_COOKIE_NAME,
      refreshName: environment.REFRESH_COOKIE_NAME,
      domain: environment.COOKIE_DOMAIN,
      secure: environment.COOKIE_SECURE,
      sameSite: environment.COOKIE_SAME_SITE,
      csrfName: environment.CSRF_COOKIE_NAME,
    },
    csrf: {
      secret: environment.CSRF_SECRET,
    },
    bcrypt: {
      rounds: environment.BCRYPT_ROUNDS,
    },
    features: {
      googleAuth: environment.GOOGLE_AUTH_ENABLED,
      email: environment.EMAIL_ENABLED,
      webPush: environment.WEB_PUSH_ENABLED,
    },
    google: {
      clientId: environment.GOOGLE_CLIENT_ID,
      clientSecret: environment.GOOGLE_CLIENT_SECRET,
      callbackUrl: environment.GOOGLE_CALLBACK_URL,
    },
    email: {
      host: environment.SMTP_HOST,
      port: environment.SMTP_PORT,
      secure: environment.SMTP_SECURE,
      user: environment.SMTP_USER,
      password: environment.SMTP_PASS,
      fromName: environment.MAIL_FROM_NAME,
      fromAddress: environment.MAIL_FROM_ADDRESS,
    },
    webPush: {
      publicKey: environment.VAPID_PUBLIC_KEY,
      privateKey: environment.VAPID_PRIVATE_KEY,
      subject: environment.VAPID_SUBJECT,
    },
    jobs: {
      remindersEnabled: environment.REMINDER_JOB_ENABLED,
      reminderCron: environment.REMINDER_JOB_CRON,
      cronSecret: environment.CRON_SECRET,
    },
    rateLimit: {
      general: {
        windowMs: environment.RATE_LIMIT_WINDOW_MS,
        max: environment.RATE_LIMIT_MAX,
      },
      auth: {
        windowMs: environment.AUTH_RATE_LIMIT_WINDOW_MS,
        max: environment.AUTH_RATE_LIMIT_MAX,
      },
    },
    security: {
      trustProxyHops: environment.TRUST_PROXY_HOPS,
    },
    tokens: {
      passwordResetTtlMinutes: environment.PASSWORD_RESET_TTL_MINUTES,
      invitationTtlDays: environment.INVITATION_TTL_DAYS,
    },
    defaults: {
      timezone: environment.DEFAULT_TIMEZONE,
      locale: environment.DEFAULT_LOCALE,
      currency: environment.DEFAULT_CURRENCY,
      safetyMarginPercent: environment.DEFAULT_SAFETY_MARGIN_PERCENT,
      contributionDay: environment.DEFAULT_CONTRIBUTION_DAY,
    },
    privacy: {
      configured: privacyConfigured,
      version: environment.PRIVACY_POLICY_VERSION ?? null,
      effectiveDate: environment.PRIVACY_POLICY_EFFECTIVE_DATE ?? null,
      controller: {
        name: environment.PRIVACY_CONTROLLER_NAME ?? null,
        contactEmail: environment.PRIVACY_CONTROLLER_CONTACT_EMAIL ?? null,
        address: environment.PRIVACY_CONTROLLER_ADDRESS ?? null,
        dpoEmail: environment.PRIVACY_DPO_EMAIL ?? null,
      },
    },
    logging: {
      level: environment.LOG_LEVEL,
    },
  });
};
