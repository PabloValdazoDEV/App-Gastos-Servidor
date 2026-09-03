import cron from 'node-cron';

import { runReminderJob } from './reminder.job.js';

export function startReminderScheduler({ prisma, config, logger }) {
  if (!config.jobs.remindersEnabled) return null;
  if (!cron.validate(config.jobs.reminderCron)) {
    throw new Error('REMINDER_JOB_CRON no contiene una expresión cron válida.');
  }

  let running = false;
  const task = cron.schedule(
    config.jobs.reminderCron,
    async () => {
      if (running) {
        logger.warn('reminder.job.skipped_overlap');
        return;
      }
      running = true;
      try {
        const result = await runReminderJob({ prisma, config });
        logger.info('reminder.job.completed', result);
      } catch (error) {
        logger.error('reminder.job.failed', {
          errorName: error?.name ?? 'Error',
          errorCode: error?.code,
        });
      } finally {
        running = false;
      }
    },
    { timezone: config.defaults.timezone },
  );

  logger.info('reminder.scheduler.started', {
    schedule: config.jobs.reminderCron,
    timezone: config.defaults.timezone,
  });
  return task;
}

