export class AppError extends Error {
  constructor({
    statusCode,
    code,
    message,
    details,
    cause,
  }) {
    super(message, { cause });

    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new TypeError('AppError statusCode must be an integer from 400 to 599.');
    }

    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
      throw new TypeError('AppError code must be an uppercase machine-readable code.');
    }

    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}
