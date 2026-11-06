import cron from 'node-cron';

import { runReminderJob } from './reminder.job.js';

export function startReminderScheduler({
  prisma,
  config,
  logger,
  runOnStartDelayMs = null,
}) {
  if (!config.jobs.remindersEnabled) return null;
  if (!cron.validate(config.jobs.reminderCron)) {
    throw new Error('REMINDER_JOB_CRON no contiene una expresión cron válida.');
  }

  let running = false;
  const execute = async () => {
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
  };
  const task = cron.schedule(config.jobs.reminderCron, execute, {
    timezone: config.defaults.timezone,
  });

  // The job is idempotent, so running it at startup catches up reminders
  // that were due while the server was stopped at the scheduled hour.
  if (Number.isInteger(runOnStartDelayMs) && runOnStartDelayMs >= 0) {
    const startupRun = setTimeout(execute, runOnStartDelayMs);
    startupRun.unref?.();
    const stop = task.stop.bind(task);
    task.stop = async (...args) => {
      clearTimeout(startupRun);
      return stop(...args);
    };
  }

  logger.info('reminder.scheduler.started', {
    schedule: config.jobs.reminderCron,
    timezone: config.defaults.timezone,
  });
  return task;
}

