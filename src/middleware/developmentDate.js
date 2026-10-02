import { AppError } from '../errors/AppError.js';
import { withBusinessDate } from '../services/businessClock.service.js';
import { toCivilDate } from '../services/date.service.js';

export const createDevelopmentDate = (nodeEnv) => (request, _response, next) => {
  const date = request.get('X-Development-Date');
  if (!date) return next();
  if (nodeEnv !== 'development') return next(new AppError({
    statusCode: 400, code: 'DEVELOPMENT_DATE_DISABLED',
    message: 'La fecha simulada solo está disponible en el servidor de desarrollo.',
  }));
  try {
    toCivilDate(date);
  } catch {
    return next(new AppError({ statusCode: 400, code: 'INVALID_DEVELOPMENT_DATE', message: 'Selecciona una fecha simulada válida (AAAA-MM-DD).' }));
  }
  return withBusinessDate(date, next);
};
