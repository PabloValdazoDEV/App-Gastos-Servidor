export const sendSuccess = (response, data, { statusCode = 200, meta } = {}) => {
  const payload = {
    success: true,
    data,
  };

  if (meta !== undefined) {
    payload.meta = meta;
  }

  return response.status(statusCode).json(payload);
};

export const sendError = (
  response,
  { statusCode, code, message, details },
) => {
  const payload = {
    success: false,
    code,
    message,
  };

  if (details !== undefined) {
    payload.details = details;
  }

  return response.status(statusCode).json(payload);
};
