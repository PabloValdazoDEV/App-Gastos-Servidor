import http from 'node:http';

import dotenv from 'dotenv';

import { createApp } from './src/app.js';
import { loadEnv } from './src/config/env.js';
import { startReminderScheduler } from './src/jobs/reminder.scheduler.js';
import { createLogger } from './src/lib/logger.js';
import { createEmailService } from './src/services/email.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const stopReminderScheduler = async (scheduler) => {
  if (!scheduler) return;

  await scheduler.stop();
  await scheduler.destroy();
};

const writeStartupFailure = (error) => {
  const isEnvironmentError = error?.name === 'EnvironmentValidationError';
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'fatal',
    event: 'app.start.failed',
    errorName: error?.name ?? 'Error',
    errorMessage: isEnvironmentError
      ? error.message
      : 'La aplicación no pudo iniciarse. Revisa los logs seguros y la configuración.',
  };

  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);

    server.once('error', handleError);
    server.listen(port, () => {
      server.off('error', handleError);
      resolve();
    });
  });

const bootstrap = async () => {
  dotenv.config();

  const config = loadEnv();
  const logger = createLogger({
    level: config.logging.level,
    bindings: {
      service: config.app.name,
      environment: config.nodeEnv,
    },
  });
  const { prisma } = await import('./src/lib/prisma.js');
  const emailService = createEmailService({ config, logger });

  if (emailService.enabled) {
    await emailService.verify();
    logger.info('email.transport.verified');
  }

  const app = createApp({ config, logger, prismaClient: prisma, emailService });
  const server = http.createServer(app);
  let reminderScheduler;

  server.requestTimeout = 65_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;

  try {
    await listen(server, config.port);
    reminderScheduler = startReminderScheduler({ prisma, config, logger });
  } catch (error) {
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await stopReminderScheduler(reminderScheduler);
    await prisma.$disconnect();
    throw error;
  }

  logger.info('app.started', {
    port: config.port,
    nodeVersion: process.version,
  });

  let shutdownPromise;

  const shutdown = (signal, cause) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.warn('app.shutdown.started', { signal });

      const forceShutdown = setTimeout(() => {
        logger.fatal('app.shutdown.timed_out', {
          timeoutMs: SHUTDOWN_TIMEOUT_MS,
        });
        server.closeAllConnections();
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);

      forceShutdown.unref();

      try {
        await stopReminderScheduler(reminderScheduler);
      } catch (error) {
        logger.error('reminder.scheduler.stop_failed', {
          errorName: error?.name ?? 'Error',
        });
        process.exitCode = 1;
      }

      const serverError = await new Promise((resolve) => {
        server.close((error) => resolve(error));
        server.closeIdleConnections();
      });

      try {
        await prisma.$disconnect();
      } catch (error) {
        logger.error('database.disconnect.failed', {
          errorName: error?.name ?? 'Error',
        });
        process.exitCode = 1;
      }

      clearTimeout(forceShutdown);

      if (serverError || cause) {
        logger.fatal('app.shutdown.failed', {
          signal,
          serverErrorName: serverError?.name,
          causeName: cause?.name,
        });
        process.exitCode = 1;
        return;
      }

      logger.info('app.shutdown.completed', { signal });
    })();

    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('uncaughtException', (error) =>
    void shutdown('uncaughtException', error),
  );
  process.once('unhandledRejection', (reason) =>
    void shutdown(
      'unhandledRejection',
      reason instanceof Error ? reason : new Error('Unhandled rejection'),
    ),
  );
};

bootstrap().catch((error) => {
  writeStartupFailure(error);
  process.exitCode = 1;
});
