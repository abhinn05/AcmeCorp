import pino from 'pino';
import { env } from './env.js';

/**
 * Credentials and API keys must never reach the logs, so they are redacted at
 * the logger rather than relying on every call site to remember.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.pass',
      '*.apiKey',
      'SMTP_PASS',
      'IMAP_PASS',
      'LLM_API_KEY',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});
