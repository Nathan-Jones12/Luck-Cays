/**
 * Scheduled jobs.
 *
 * node-cron, per the PRD's first option. BullMQ would be the move once there is more than
 * one API instance: with in-process cron, two instances would each run every job, and while
 * every job here is idempotent (settlement guards on `status: "open"`, cashback keys on the
 * week start) duplicating the work is still waste.
 *
 * Jobs never throw into the scheduler. An unhandled rejection in a cron tick would take the
 * process down, so each one catches and logs.
 */
import cron, { type ScheduledTask } from "node-cron";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { settleResolvedEvents } from "../modules/sports/sports.service.js";
import { finishDueDemoEvents, syncFromProvider } from "../modules/sports/sports.sync.js";
import { payWeeklyCashback } from "../modules/vip/vip.service.js";
import { pruneExpiredTokens } from "../modules/auth/tokens.js";

const tasks: ScheduledTask[] = [];

/** Wrap a job so a failure is logged and never reaches the scheduler. */
function safely(name: string, job: () => Promise<unknown>): () => void {
  return () => {
    void job()
      .then((result) => logger.debug({ job: name, result }, "job finished"))
      .catch((error: unknown) => logger.error({ err: error, job: name }, "job failed"));
  };
}

export function startJobs(): void {
  // Fixtures and odds. Falls back to demo fixtures when no API key is configured.
  tasks.push(cron.schedule(env.SPORTS_SYNC_CRON, safely("sports.sync", syncFromProvider)));

  // Settlement, every two minutes. Grading is idempotent, so a tick that overlaps the
  // previous one cannot pay a bet twice.
  tasks.push(
    cron.schedule(
      "*/2 * * * *",
      safely("sports.settle", async () => {
        // Without a live provider nothing ever reaches a final score, so the demo helper
        // finishes fixtures whose start time has passed and gives settlement something to do.
        await finishDueDemoEvents();
        const run = await settleResolvedEvents();
        return { graded: run.graded, paidOut: run.paidOut.toString(10) };
      }),
    ),
  );

  // Weekly cashback. Hourly rather than weekly: the job itself decides whose week has
  // elapsed, so running it often costs nothing and means a restart cannot skip a payout.
  tasks.push(
    cron.schedule(
      "0 * * * *",
      safely("vip.cashback", async () => {
        const run = await payWeeklyCashback();
        return { paid: run.paid, totalChips: run.totalChips.toString(10) };
      }),
    ),
  );

  // Housekeeping: drop long-expired refresh tokens.
  tasks.push(cron.schedule("30 3 * * *", safely("auth.pruneTokens", pruneExpiredTokens)));

  logger.info({ jobs: tasks.length, sportsSync: env.SPORTS_SYNC_CRON }, "scheduled jobs started");
}

export function stopJobs(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}
