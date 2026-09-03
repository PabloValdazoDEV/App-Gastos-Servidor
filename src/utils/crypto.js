import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = (byteLength = 32) =>
  randomBytes(byteLength).toString('base64url');

export const sha256 = (value) =>
  createHash('sha256').update(String(value)).digest('hex');

export const sha256Base64Url = (value) =>
  createHash('sha256').update(String(value)).digest('base64url');

export const hmacSha256 = (secret, value) =>
  createHmac('sha256', secret).update(String(value)).digest('base64url');

export const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

export const hashNetworkIdentifier = (value, pepper) =>
  value ? hmacSha256(pepper, value) : null;
