import { createApp } from './app.js';
import { env, imapConfigured } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDatabase, connectToDatabase } from './repositories/mongo.js';
import { organizationRepo } from './repositories/index.js';
import { runInboxCheck, runReminderSweep } from './services/collections/agent.js';

/**
 * Start-up, the background schedulers and a clean shut-down.
 *
 * The two schedulers are plain timers rather than a job framework: this is one
 * process, and a timer that skips its turn while the previous run is still
 * going is all the scheduling this needs. Both are safe to run alongside the
 * manual buttons in the front end, because the work they do is idempotent at
 * the database level rather than guarded by an in-memory flag.
 */

async function main(): Promise<void> {
  await connectToDatabase();

  const organization = await organizationRepo.get();
  if (!organization) {
    logger.warn('The database is empty. Run "npm run seed" to load the supplied data.');
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'API listening');
  });

  const timers: NodeJS.Timeout[] = [];

  if (imapConfigured && env.IMAP_POLL_SECONDS > 0) {
    let running = false;
    timers.push(
      setInterval(async () => {
        if (running) return;
        running = true;
        try {
          const result = await runInboxCheck();
          if (result.fetched > 0) logger.info(result, 'inbox checked');
        } catch (error) {
          logger.error({ err: error }, 'the inbox poll failed');
        } finally {
          running = false;
        }
      }, env.IMAP_POLL_SECONDS * 1000),
    );
    logger.info({ everySeconds: env.IMAP_POLL_SECONDS }, 'polling the inbox for replies');
  } else {
    logger.warn('Inbox polling is off. Use the "Check inbox now" button, or configure IMAP.');
  }

  if (env.REMINDER_SWEEP_SECONDS > 0) {
    let running = false;
    timers.push(
      setInterval(async () => {
        if (running) return;
        running = true;
        try {
          const result = await runReminderSweep();
          if (result.sent.length > 0) logger.info({ sent: result.sent.length }, 'reminders sent');
        } catch (error) {
          logger.error({ err: error }, 'the reminder sweep failed');
        } finally {
          running = false;
        }
      }, env.REMINDER_SWEEP_SECONDS * 1000),
    );
    logger.info({ everySeconds: env.REMINDER_SWEEP_SECONDS }, 'sweeping for overdue invoices');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    for (const timer of timers) clearInterval(timer);
    server.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({ err: error }, 'the server failed to start');
  process.exit(1);
});
