import { z } from 'zod';

export const updateAccessBodySchema = z
  .object({ role: z.enum(['ADMIN', 'MEMBER']) })
  .strict();

