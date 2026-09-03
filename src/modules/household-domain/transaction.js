const SERIALIZATION_ERROR_CODE = 'P2034';

export const runSerializableTransaction = async (
  prisma,
  operation,
  { maxAttempts = 3 } = {},
) => {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: 'Serializable',
      });
    } catch (error) {
      lastError = error;

      if (error?.code !== SERIALIZATION_ERROR_CODE || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw lastError;
};

