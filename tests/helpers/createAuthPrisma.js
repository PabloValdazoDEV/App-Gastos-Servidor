import { randomUUID } from 'node:crypto';

const matchesWhere = (record, where = {}) => {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'user') continue;

    const actual = record[key];

    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('gt' in expected && !(actual > expected.gt)) return false;
      if ('not' in expected && actual === expected.not) return false;
      continue;
    }

    if (actual !== expected) return false;
  }

  return true;
};

const applyData = (record, data) => {
  Object.assign(record, data, { updatedAt: new Date() });
  return record;
};

export const createAuthPrisma = () => {
  const state = {
    users: [],
    sessions: [],
    resetTokens: [],
    oauthAccounts: [],
    legalDocumentAcceptances: [],
    auditLogs: [],
  };

  const client = {
    state,
    user: {
      async create({ data }) {
        if (state.users.some((user) => user.email === data.email)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }

        const now = new Date();
        const user = {
          id: randomUUID(),
          passwordHash: null,
          emailVerifiedAt: null,
          isActive: true,
          timezone: 'Europe/Madrid',
          locale: 'es-ES',
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        state.users.push(user);
        return { ...user };
      },
      async findUnique({ where }) {
        const [key, value] = Object.entries(where)[0];
        const user = state.users.find((entry) => entry[key] === value);
        return user ? { ...user } : null;
      },
      async update({ where, data }) {
        const user = state.users.find((entry) => entry.id === where.id);
        if (!user) throw new Error('User not found');
        return { ...applyData(user, data) };
      },
    },
    refreshSession: {
      async create({ data }) {
        const now = new Date();
        const session = {
          createdAt: now,
          lastUsedAt: null,
          revokedAt: null,
          revocationReason: null,
          rotatedFromSessionId: null,
          ...data,
        };
        state.sessions.push(session);
        return { ...session };
      },
      async findFirst({ where, include }) {
        const session = state.sessions.find((entry) => matchesWhere(entry, where));
        if (!session) return null;
        const result = { ...session };
        if (include?.user) {
          result.user = {
            ...state.users.find((user) => user.id === session.userId),
          };
        }
        if (where.user?.isActive && !result.user?.isActive) return null;
        return result;
      },
      async findUnique({ where, include }) {
        const session = state.sessions.find((entry) => entry.id === where.id);
        if (!session) return null;
        const result = { ...session };
        if (include?.user) {
          result.user = {
            ...state.users.find((user) => user.id === session.userId),
          };
        }
        return result;
      },
      async findMany({ where, orderBy, select }) {
        const sessions = state.sessions.filter((entry) => matchesWhere(entry, where));
        if (orderBy?.createdAt === 'desc') {
          sessions.sort((left, right) => right.createdAt - left.createdAt);
        }
        return sessions.map((session) =>
          Object.fromEntries(
            Object.entries(select)
              .filter(([, included]) => included)
              .map(([key]) => [key, session[key]]),
          ),
        );
      },
      async updateMany({ where, data }) {
        const sessions = state.sessions.filter((entry) => matchesWhere(entry, where));
        sessions.forEach((session) => applyData(session, data));
        return { count: sessions.length };
      },
    },
    passwordResetToken: {
      async create({ data }) {
        const token = {
          id: randomUUID(),
          usedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.resetTokens.push(token);
        return { ...token };
      },
      async findUnique({ where }) {
        const token = state.resetTokens.find(
          (entry) => entry.tokenHash === where.tokenHash,
        );
        return token ? { ...token } : null;
      },
      async updateMany({ where, data }) {
        const tokens = state.resetTokens.filter((entry) =>
          matchesWhere(entry, where),
        );
        tokens.forEach((token) => applyData(token, data));
        return { count: tokens.length };
      },
    },
    auditLog: {
      async create({ data }) {
        const audit = { id: randomUUID(), createdAt: new Date(), ...data };
        state.auditLogs.push(audit);
        return { ...audit };
      },
    },
    legalDocumentAcceptance: {
      async create({ data }) {
        const duplicate = state.legalDocumentAcceptances.some(
          (acceptance) =>
            acceptance.userId === data.userId &&
            acceptance.documentType === data.documentType &&
            acceptance.documentVersion === data.documentVersion,
        );

        if (duplicate) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }

        const now = new Date();
        const acceptance = {
          id: randomUUID(),
          acceptedAt: now,
          createdAt: now,
          ...data,
        };
        state.legalDocumentAcceptances.push(acceptance);
        return { ...acceptance };
      },
    },
    oAuthAccount: {
      async findUnique({ where, include } = {}) {
        const identity = where?.provider_providerAccountId;
        const account = identity
          ? state.oauthAccounts.find(
              (entry) =>
                entry.provider === identity.provider &&
                entry.providerAccountId === identity.providerAccountId,
            )
          : null;

        if (!account) return null;
        const result = { ...account };

        if (include?.user) {
          result.user = {
            ...state.users.find((user) => user.id === account.userId),
          };
        }

        return result;
      },
      async create({ data }) {
        const account = { id: randomUUID(), ...data };
        state.oauthAccounts.push(account);
        return { ...account };
      },
    },
    async $transaction(callback) {
      const snapshot = structuredClone(state);

      try {
        return await callback(client);
      } catch (error) {
        for (const [key, records] of Object.entries(snapshot)) {
          state[key].splice(0, state[key].length, ...records);
        }

        throw error;
      }
    },
  };

  return client;
};
