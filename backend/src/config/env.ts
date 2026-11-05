import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { z } from 'zod';

/**
 * One .env at the repository root serves both services, so look there as well
 * as in this package. `dotenv/config` alone would only read backend/.env and
 * would silently fall back to defaults when the file sits a level up.
 */
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
  if (existsSync(candidate)) {
    loadEnvFile({ path: candidate });
    break;
  }
}

/**
 * Every environment variable the application reads is declared here and nowhere
 * else. Parsing fails loudly at boot rather than producing `undefined` deep
 * inside a request handler.
 */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v.toLowerCase() === 'true'));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  PORT: int(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  MONGODB_DB: z.string().default('sonic_collections'),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('AcmeCorp Accounts Team'),
  MAIL_FROM_ADDRESS: z.string().default(''),

  IMAP_HOST: z.string().default(''),
  IMAP_PORT: int(993),
  IMAP_SECURE: bool(true),
  IMAP_USER: z.string().default(''),
  IMAP_PASS: z.string().default(''),
  IMAP_MAILBOX: z.string().default('INBOX'),

  MAIL_TRANSPORT: z.enum(['smtp', 'mock']).default('smtp'),
  IMAP_POLL_SECONDS: int(60),
  REMINDER_SWEEP_SECONDS: int(900),
  REMINDER_MIN_INTERVAL_DAYS: int(5),

  LLM_PROVIDER: z.enum(['gemini', 'openai-compatible']).default('gemini'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gemini-2.0-flash'),
  LLM_BASE_URL: z.string().default(''),
  LLM_ENABLED: bool(true),

  AGENT_AUTOSEND_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0.75 : Number(v)))
    .pipe(z.number().min(0).max(1)),
  RECON_LLM_RERANK: bool(false),

  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/** The LLM is only usable when it is switched on and a key is actually present. */
export const llmConfigured = env.LLM_ENABLED && env.LLM_API_KEY.length > 0;

/** Real SMTP/IMAP need both a host and credentials; otherwise we fall back to the mock. */
export const smtpConfigured =
  env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST !== '' && env.SMTP_USER !== '';
export const imapConfigured =
  env.MAIL_TRANSPORT === 'smtp' && env.IMAP_HOST !== '' && env.IMAP_USER !== '';

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
