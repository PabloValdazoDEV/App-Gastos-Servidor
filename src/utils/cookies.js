const decodeCookieValue = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseCookies = (cookieHeader = '') => {
  const cookies = Object.create(null);

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');

    if (separator < 1) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name && cookies[name] === undefined) {
      cookies[name] = decodeCookieValue(value);
    }
  }

  return cookies;
};

const sharedCookieOptions = (config) => ({
  secure: config.cookies.secure,
  sameSite: config.cookies.sameSite,
  domain: config.cookies.domain,
});

export const authCookieOptions = (config, maxAge) => ({
  ...sharedCookieOptions(config),
  httpOnly: true,
  path: '/',
  maxAge,
});

export const csrfCookieOptions = (config, maxAge) => ({
  ...sharedCookieOptions(config),
  httpOnly: false,
  path: '/',
  maxAge,
});

export const temporaryCookieOptions = (config, path, maxAge) => ({
  ...sharedCookieOptions(config),
  httpOnly: true,
  path,
  maxAge,
});

export const clearAuthCookies = (response, config) => {
  const common = sharedCookieOptions(config);

  response.clearCookie(config.cookies.authName, {
    ...common,
    httpOnly: true,
    path: '/',
  });
  response.clearCookie(config.cookies.refreshName, {
    ...common,
    httpOnly: true,
    path: '/',
  });
};
