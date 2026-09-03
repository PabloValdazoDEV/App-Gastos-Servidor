import { randomUUID } from 'node:crypto';

import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
} from 'jose';

import { AppError } from '../errors/AppError.js';
import { toPublicUser } from '../middleware/authenticate.js';
import {
  hashNetworkIdentifier,
  randomToken,
  safeEqual,
  sha256Base64Url,
} from '../utils/crypto.js';
import { verifyPassword } from './password.service.js';
import {
  recordRegistrationPrivacyAcceptance,
  resolveRegistrationPrivacyPolicy,
} from './privacyPolicy.service.js';

const encoder = new TextEncoder();
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const TEMPORARY_TTL = '10m';
const TEMPORARY_MAX_AGE_MS = 10 * 60_000;

const featureDisabled = () =>
  new AppError({
    statusCode: 404,
    code: 'GOOGLE_AUTH_DISABLED',
    message: 'El acceso con Google no está disponible.',
  });

const googleFailure = () =>
  new AppError({
    statusCode: 400,
    code: 'GOOGLE_AUTH_FAILED',
    message: 'No se pudo completar el acceso con Google.',
  });

const temporaryContext = (config, type) => ({
  secret: encoder.encode(config.csrf.secret),
  issuer: config.app.serverUrl,
  audience: `${config.app.name}:${type}`,
});

const signTemporary = (config, type, claims) => {
  const context = temporaryContext(config, type);

  return new SignJWT({ ...claims, tokenType: type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(context.issuer)
    .setAudience(context.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(TEMPORARY_TTL)
    .sign(context.secret);
};

const verifyTemporary = async (config, type, token) => {
  const context = temporaryContext(config, type);
  const { payload } = await jwtVerify(token, context.secret, {
    algorithms: ['HS256'],
    issuer: context.issuer,
    audience: context.audience,
    requiredClaims: ['exp', 'iat', 'jti', 'tokenType'],
  });

  if (payload.tokenType !== type) throw googleFailure();
  return payload;
};

const exchangeAuthorizationCode = async ({ config, code, codeVerifier }) => {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: config.google.callbackUrl,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw googleFailure();

  const payload = await response.json();

  if (typeof payload.id_token !== 'string') throw googleFailure();
  return payload.id_token;
};

const normalizeGoogleIdentity = (payload, expectedNonce) => {
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.email !== 'string' ||
    payload.email_verified !== true ||
    typeof payload.nonce !== 'string' ||
    !safeEqual(payload.nonce, expectedNonce)
  ) {
    throw googleFailure();
  }

  return {
    providerAccountId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name:
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 120)
        : payload.email.split('@')[0].slice(0, 120),
  };
};

export const createGoogleAuthService = ({
  prisma,
  config,
  authService,
  jwks = createRemoteJWKSet(GOOGLE_JWKS_URL),
}) => ({
  oauthCookieName: `${config.cookies.authName}_google_oauth`,
  linkCookieName: `${config.cookies.authName}_google_link`,
  temporaryMaxAgeMs: TEMPORARY_MAX_AGE_MS,

  async start({
    privacyPolicyAcknowledged = false,
    privacyPolicyVersion,
  } = {}) {
    if (!config.features.googleAuth) throw featureDisabled();

    const acknowledgedPolicyVersion = privacyPolicyAcknowledged
      ? resolveRegistrationPrivacyPolicy({
          config,
          privacyPolicyAcknowledged,
          privacyPolicyVersion,
        })
      : null;

    const state = randomToken(32);
    const nonce = randomToken(32);
    const codeVerifier = randomToken(64);
    const oauthCookie = await signTemporary(config, 'google-oauth', {
      state,
      nonce,
      codeVerifier,
      privacyPolicyAcknowledged: privacyPolicyAcknowledged === true,
      privacyPolicyVersion: acknowledgedPolicyVersion,
    });
    const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);

    authorizationUrl.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: sha256Base64Url(codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();

    return { authorizationUrl: authorizationUrl.toString(), oauthCookie };
  },

  async callback({ code, state, oauthCookie, accessToken, requestContext }) {
    if (!config.features.googleAuth) throw featureDisabled();

    let oauthState;

    try {
      oauthState = await verifyTemporary(
        config,
        'google-oauth',
        oauthCookie,
      );
    } catch {
      throw googleFailure();
    }

    if (
      typeof oauthState.state !== 'string' ||
      typeof oauthState.nonce !== 'string' ||
      typeof oauthState.codeVerifier !== 'string' ||
      typeof oauthState.privacyPolicyAcknowledged !== 'boolean' ||
      !(
        oauthState.privacyPolicyVersion === null ||
        typeof oauthState.privacyPolicyVersion === 'string'
      ) ||
      !safeEqual(state, oauthState.state)
    ) {
      throw googleFailure();
    }

    const idToken = await exchangeAuthorizationCode({
      config,
      code,
      codeVerifier: oauthState.codeVerifier,
    });
    const { payload } = await jwtVerify(idToken, jwks, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.google.clientId,
      requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'exp', 'iat'],
    });
    const identity = normalizeGoogleIdentity(payload, oauthState.nonce);
    const existingAccount = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: 'GOOGLE',
          providerAccountId: identity.providerAccountId,
        },
      },
      include: { user: true },
    });

    if (existingAccount) {
      if (!existingAccount.user.isActive) throw googleFailure();
      return prisma.$transaction(async (tx) => {
        const session = await authService.issueSession({
          user: existingAccount.user,
          requestContext,
          tx,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: existingAccount.user.id,
            action: 'LOGIN',
            resourceType: 'User',
            resourceId: existingAccount.user.id,
            metadata: { provider: 'GOOGLE' },
            ipAddressHash: hashNetworkIdentifier(
              requestContext.ipAddress,
              config.csrf.secret,
            ),
          },
        });
        return {
          kind: 'session',
          user: toPublicUser(existingAccount.user),
          session,
        };
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: identity.email },
    });

    if (!existingUser) {
      resolveRegistrationPrivacyPolicy({
        config,
        privacyPolicyAcknowledged: oauthState.privacyPolicyAcknowledged,
        privacyPolicyVersion: oauthState.privacyPolicyVersion,
      });

      return prisma.$transaction(async (tx) => {
        const documentVersion = resolveRegistrationPrivacyPolicy({
          config,
          privacyPolicyAcknowledged: oauthState.privacyPolicyAcknowledged,
          privacyPolicyVersion: oauthState.privacyPolicyVersion,
        });
        const user = await tx.user.create({
          data: {
            email: identity.email,
            name: identity.name,
            emailVerifiedAt: new Date(),
            timezone: config.defaults.timezone,
            locale: config.defaults.locale,
          },
        });

        await recordRegistrationPrivacyAcceptance({
          tx,
          userId: user.id,
          documentVersion,
        });

        await tx.oAuthAccount.create({
          data: {
            userId: user.id,
            provider: 'GOOGLE',
            providerAccountId: identity.providerAccountId,
            providerEmail: identity.email,
          },
        });
        const session = await authService.issueSession({
          user,
          requestContext,
          tx,
        });

        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            action: 'REGISTER',
            resourceType: 'User',
            resourceId: user.id,
            metadata: { provider: 'GOOGLE' },
          },
        });

        return { kind: 'session', user: toPublicUser(user), session };
      });
    }

    let authenticatedUserId;

    if (accessToken) {
      try {
        const accessPayload = await authService.tokens.verifyAccess(accessToken);
        const activeSession = await prisma.refreshSession.findFirst({
          where: {
            id: accessPayload.sessionId,
            userId: accessPayload.sub,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        authenticatedUserId = activeSession?.userId;
      } catch {
        authenticatedUserId = undefined;
      }
    }

    if (authenticatedUserId === existingUser.id) {
      return prisma.$transaction(async (tx) => {
        await tx.oAuthAccount.create({
          data: {
            userId: existingUser.id,
            provider: 'GOOGLE',
            providerAccountId: identity.providerAccountId,
            providerEmail: identity.email,
          },
        });
        const session = await authService.issueSession({
          user: existingUser,
          requestContext,
          tx,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: existingUser.id,
            action: 'LOGIN',
            resourceType: 'User',
            resourceId: existingUser.id,
            metadata: { provider: 'GOOGLE', linked: true },
            ipAddressHash: hashNetworkIdentifier(
              requestContext.ipAddress,
              config.csrf.secret,
            ),
          },
        });
        return {
          kind: 'session',
          user: toPublicUser(existingUser),
          session,
        };
      });
    }

    const linkCookie = await signTemporary(config, 'google-link', identity);
    return { kind: 'link_required', linkCookie };
  },

  async confirmLink({ linkCookie, password, suppliedEmail, requestContext }) {
    if (!config.features.googleAuth) throw featureDisabled();

    let identity;

    try {
      identity = await verifyTemporary(config, 'google-link', linkCookie);
    } catch {
      throw googleFailure();
    }

    if (
      typeof identity.email !== 'string' ||
      typeof identity.providerAccountId !== 'string' ||
      (suppliedEmail && suppliedEmail !== identity.email)
    ) {
      throw googleFailure();
    }

    const user = await prisma.user.findUnique({ where: { email: identity.email } });
    const matches = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : false;

    if (!user || !user.isActive || !matches) {
      throw new AppError({
        statusCode: 401,
        code: 'GOOGLE_LINK_REAUTH_FAILED',
        message: 'No se pudo confirmar la cuenta local.',
      });
    }

    return prisma.$transaction(async (tx) => {
      await tx.oAuthAccount.create({
        data: {
          userId: user.id,
          provider: 'GOOGLE',
          providerAccountId: identity.providerAccountId,
          providerEmail: identity.email,
        },
      });
      const session = await authService.issueSession({
        user,
        requestContext,
        tx,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'LOGIN',
          resourceType: 'User',
          resourceId: user.id,
          metadata: { provider: 'GOOGLE', linked: true },
          ipAddressHash: hashNetworkIdentifier(
            requestContext.ipAddress,
            config.csrf.secret,
          ),
        },
      });

      return { user: toPublicUser(user), session };
    });
  },
});
