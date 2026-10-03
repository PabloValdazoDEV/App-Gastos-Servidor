import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runReminderJob } from '../src/jobs/reminder.job.js';
import { startReminderScheduler } from '../src/jobs/reminder.scheduler.js';

vi.mock('../src/jobs/reminder.job.js', () => ({
  runReminderJob: vi.fn(),
}));

const config = {
  jobs: { remindersEnabled: true, reminderCron: '0 10 * * *' },
  defaults: { timezone: 'Europe/Madrid' },
};

describe('reminder scheduler at 10:00 Europe/Madrid', () => {
  let task;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (task) {
      await task.stop();
      await task.destroy();
      task = undefined;
    }
    vi.useRealTimers();
  });

  it('does not schedule reminders when the job is disabled', async () => {
    const disabledConfig = {
      ...config,
      jobs: { ...config.jobs, remindersEnabled: false },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    task = startReminderScheduler({ prisma: {}, config: disabledConfig, logger });

    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000);

    expect(task).toBeNull();
    expect(runReminderJob).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'ordinary winter days',
      start: '2026-01-15T08:55:00Z',
      firstRun: '2026-01-15T09:00:00Z',
      nextRun: '2026-01-16T09:00:00Z',
    },
    {
      name: 'ordinary summer days',
      start: '2026-07-15T07:55:00Z',
      firstRun: '2026-07-15T08:00:00Z',
      nextRun: '2026-07-16T08:00:00Z',
    },
    {
      name: 'the switch to summer time on March 29',
      start: '2026-03-28T08:55:00Z',
      firstRun: '2026-03-28T09:00:00Z',
      nextRun: '2026-03-29T08:00:00Z',
    },
    {
      name: 'the switch to winter time on October 25',
      start: '2026-10-24T07:55:00Z',
      firstRun: '2026-10-24T08:00:00Z',
      nextRun: '2026-10-25T09:00:00Z',
    },
  ])('runs once at 10:00 on $name', async ({ start, firstRun, nextRun }) => {
    vi.setSystemTime(new Date(start));
    const executions = [];
    runReminderJob.mockImplementation(async () => {
      executions.push(new Date().toISOString().slice(0, 19));
      return { generation: { created: 0 }, delivery: { sent: 0 } };
    });
    const prisma = {};
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    task = startReminderScheduler({ prisma, config, logger });

    await vi.advanceTimersByTimeAsync(Date.parse(firstRun) - Date.now() - 1);
    expect(runReminderJob).not.toHaveBeenCalled();

    // The scheduler dispatches its callback through a second, zero-delay timer.
    await vi.advanceTimersByTimeAsync(2);
    expect(executions).toEqual([firstRun.slice(0, 19)]);
    expect(runReminderJob).toHaveBeenLastCalledWith({ prisma, config });

    await vi.advanceTimersByTimeAsync(Date.parse(nextRun) - Date.now() + 1);
    expect(executions).toEqual([firstRun.slice(0, 19), nextRun.slice(0, 19)]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runReminderJob).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
