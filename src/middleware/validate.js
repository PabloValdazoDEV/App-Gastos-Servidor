export const validate = (schemas) => (request, _response, next) => {
  for (const [source, schema] of Object.entries(schemas)) {
    const value = schema.parse(request[source]);

    Object.defineProperty(request, source, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }

  next();
};
