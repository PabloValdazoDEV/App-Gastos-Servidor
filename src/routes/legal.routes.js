import { Router } from 'express';

import { sendSuccess } from '../utils/httpResponses.js';

export const createLegalRouter = ({ config }) => {
  if (!config?.privacy) {
    throw new TypeError('createLegalRouter requires privacy configuration.');
  }

  const router = Router();

  router.get('/privacy-policy', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    return sendSuccess(response, config.privacy);
  });

  return router;
};
