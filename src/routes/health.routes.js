import { Router } from 'express';

import { sendSuccess } from '../utils/httpResponses.js';

export const createHealthRouter = ({ appName, nodeEnv }) => {
  const router = Router();

  router.get('/', (_request, response) => {
    response.set('Cache-Control', 'no-store');

    sendSuccess(response, {
      status: 'ok',
      service: appName,
      environment: nodeEnv,
    });
  });

  return router;
};
