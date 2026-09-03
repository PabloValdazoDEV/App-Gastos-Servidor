import { PrismaClient } from '@prisma/client';

const PRISMA_SINGLETON = Symbol.for('budgetapp.prisma');

const globalPrisma = globalThis;

export const prisma =
  globalPrisma[PRISMA_SINGLETON] ??
  new PrismaClient({
    log: [],
  });

globalPrisma[PRISMA_SINGLETON] = prisma;

export default prisma;
