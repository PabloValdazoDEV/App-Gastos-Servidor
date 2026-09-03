import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

const encoder = new TextEncoder();
const ACCESS_TYPE = 'access+jwt';
const REFRESH_TYPE = 'refresh+jwt';

const durationMultipliers = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

export const durationToMilliseconds = (duration) => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration);

  if (!match) {
    throw new TypeError('Invalid token duration.');
  }

  return Number(match[1]) * durationMultipliers[match[2]];
};

const createJwtContext = (config) => ({
  issuer: config.app.serverUrl,
  audience: `${config.app.name}:web`,
});

const sign = ({ secret, context, subject, type, expiresIn, claims }) =>
  new SignJWT({ ...claims, tokenType: type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject)
    .setIssuer(context.issuer)
    .setAudience(context.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiresIn)
    .sign(encoder.encode(secret));

const verify = async ({ token, secret, context, type }) => {
  const { payload } = await jwtVerify(token, encoder.encode(secret), {
    algorithms: ['HS256'],
    issuer: context.issuer,
    audience: context.audience,
    requiredClaims: ['sub', 'exp', 'iat', 'jti', 'tokenType'],
  });

  if (payload.tokenType !== type || typeof payload.sub !== 'string') {
    throw new Error('Unexpected token type.');
  }

  return payload;
};

export const createTokenService = (config) => {
  const context = createJwtContext(config);

  return Object.freeze({
    accessMaxAgeMs: durationToMilliseconds(config.jwt.accessTtl),
    refreshMaxAgeMs: config.jwt.refreshTtlDays * 86_400_000,

    signAccess({ userId, sessionId }) {
      return sign({
        secret: config.jwt.accessSecret,
        context,
        subject: userId,
        type: ACCESS_TYPE,
        expiresIn: config.jwt.accessTtl,
        claims: { sessionId },
      });
    },

    signRefresh({ userId, sessionId, familyId }) {
      return sign({
        secret: config.jwt.refreshSecret,
        context,
        subject: userId,
        type: REFRESH_TYPE,
        expiresIn: `${config.jwt.refreshTtlDays}d`,
        claims: { sessionId, familyId },
      });
    },

    verifyAccess(token) {
      return verify({
        token,
        secret: config.jwt.accessSecret,
        context,
        type: ACCESS_TYPE,
      });
    },

    verifyRefresh(token) {
      return verify({
        token,
        secret: config.jwt.refreshSecret,
        context,
        type: REFRESH_TYPE,
      });
    },
  });
};
