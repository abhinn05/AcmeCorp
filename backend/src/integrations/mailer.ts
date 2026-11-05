import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, smtpConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Outbound email.
 *
 * Two transports implement the same interface: real SMTP, and a mock that
 * writes each message to disk. The mock exists so the whole application can be
 * run, demonstrated and tested without a mailbox, and so that nothing is ever
 * accidentally sent to a real address while developing.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** Threading headers, so a reply lands under the original in the client. */
  inReplyTo?: string | null;
  references?: string[];
}

export interface SentEmail {
  messageId: string;
  accepted: boolean;
}

export interface Mailer {
  readonly kind: 'smtp' | 'mock';
  send(email: OutboundEmail): Promise<SentEmail>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}

const MOCK_DIR = resolve(process.cwd(), '.mailbox');

class MockMailer implements Mailer {
  readonly kind = 'mock' as const;

  async send(email: OutboundEmail): Promise<SentEmail> {
    mkdirSync(MOCK_DIR, { recursive: true });
    const messageId = `<${randomUUID()}@mock.local>`;
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${email.to.replace(/[^\w.@-]/g, '_')}.txt`;
    writeFileSync(
      resolve(MOCK_DIR, filename),
      [
        `To: ${email.to}`,
        `Subject: ${email.subject}`,
        `Message-ID: ${messageId}`,
        email.inReplyTo ? `In-Reply-To: ${email.inReplyTo}` : '',
        '',
        email.text,
      ]
        .filter(Boolean)
        .join('\n'),
      'utf8',
    );
    logger.info({ to: email.to, subject: email.subject }, 'mock mail written to disk');
    return { messageId, accepted: true };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `Mock transport. Messages are written to ${MOCK_DIR}` };
  }
}

class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transporter: Transporter;

  constructor(private readonly from: string) {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      inReplyTo: email.inReplyTo ?? undefined,
      references: email.references?.length ? email.references : undefined,
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).length > 0,
    };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.transporter.verify();
      return { ok: true, detail: `Connected to ${env.SMTP_HOST}:${env.SMTP_PORT}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (mailer) return mailer;
  if (smtpConfigured) {
    const address = env.MAIL_FROM_ADDRESS || env.SMTP_USER;
    mailer = new SmtpMailer(`"${env.MAIL_FROM_NAME}" <${address}>`);
  } else {
    logger.warn('SMTP is not configured; falling back to the mock mail transport');
    mailer = new MockMailer();
  }
  return mailer;
}

/** Used by the tests to inject a transport that records what was sent. */
export function setMailer(replacement: Mailer | null): void {
  mailer = replacement;
}

export const MOCK_MAILBOX_DIR = MOCK_DIR;
