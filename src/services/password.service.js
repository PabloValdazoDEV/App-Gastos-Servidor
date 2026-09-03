import { createHash } from 'node:crypto';

import bcrypt from 'bcrypt';

const preparePassword = (password) =>
  `budgetapp-password-v1:${createHash('sha512')
    .update(password, 'utf8')
    .digest('base64url')}`;

export const hashPassword = (password, rounds) =>
  bcrypt.hash(preparePassword(password), rounds);

export const verifyPassword = (password, passwordHash) =>
  bcrypt.compare(preparePassword(password), passwordHash);
