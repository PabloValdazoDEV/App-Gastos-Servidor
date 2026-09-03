import { AppError } from '../errors/AppError.js';

export const notFoundHandler = (_request, _response, next) => {
  next(
    new AppError({
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      message: 'No se encontró la ruta solicitada.',
    }),
  );
};
