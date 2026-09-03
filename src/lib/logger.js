const LEVEL_PRIORITY = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: Number.POSITIVE_INFINITY,
});

const SENSITIVE_KEY =
  /(?:authorization|authSecret|cookie|credential|database[_-]?url|password|passwd|private[_-]?key|secret|smtp[_-]?pass|token|api[_-]?key)/i;

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2_000;

const truncate = (value) =>
  value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;

const sanitize = (value, key, seen, depth) => {
  if (key && SENSITIVE_KEY.test(key)) {
    return '[REDACTED]';
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return { name: value.name };
  }

  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';

  seen.add(value);

  if (Array.isArray(value)) {
    const sanitizedArray = value.map((entry) =>
      sanitize(entry, undefined, seen, depth + 1),
    );
    seen.delete(value);
    return sanitizedArray;
  }

  const sanitizedObject = {};

  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitizedValue = sanitize(childValue, childKey, seen, depth + 1);

    if (sanitizedValue !== undefined) {
      sanitizedObject[childKey] = sanitizedValue;
    }
  }

  seen.delete(value);
  return sanitizedObject;
};

export const sanitizeLogData = (data) => sanitize(data, undefined, new WeakSet(), 0);

const writeJsonLine = (destination, entry) => {
  destination.write(`${JSON.stringify(entry)}\n`);
};

export const createLogger = ({
  level = 'info',
  destination = process.stdout,
  errorDestination = process.stderr,
  bindings = {},
} = {}) => {
  if (!(level in LEVEL_PRIORITY)) {
    throw new TypeError(`Unsupported log level: ${level}`);
  }

  const threshold = LEVEL_PRIORITY[level];
  const safeBindings = sanitizeLogData(bindings);

  const log = (logLevel, event, data = {}) => {
    if (LEVEL_PRIORITY[logLevel] < threshold) return;

    const safeData = sanitizeLogData(data);
    const entry = {
      ...safeBindings,
      ...safeData,
      timestamp: new Date().toISOString(),
      level: logLevel,
      event: truncate(String(event)),
    };
    const output = LEVEL_PRIORITY[logLevel] >= LEVEL_PRIORITY.error
      ? errorDestination
      : destination;

    writeJsonLine(output, entry);
  };

  return Object.freeze({
    debug: (event, data) => log('debug', event, data),
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data) => log('error', event, data),
    fatal: (event, data) => log('fatal', event, data),
  });
};
