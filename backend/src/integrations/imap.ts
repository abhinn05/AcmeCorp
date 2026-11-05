import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { env, imapConfigured } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Inbound email.
 *
 * Replies are fetched over IMAP, parsed into a small plain shape, and handed to
 * the collections agent. Nothing here decides anything: this module's only job
 * is to turn a mailbox into a list of messages. Messages are left unread or
 * marked seen by the caller, and de-duplication happens in the database, not
 * here, so a crash halfway through a batch cannot lose or repeat a reply.
 */

export interface InboundEmail {
  /** Stable identity for de-duplication: the RFC Message-ID, or UID as a fallback. */
  key: string;
  uid: number;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  subject: string;
  text: string;
  date: Date;
  headers: Record<string, string>;
}

const MAX_BODY_CHARS = 20_000;

function headerString(mail: ParsedMail, name: string): string {
  const value = mail.headers.get(name);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}

/**
 * The visible part of a reply, with the quoted history removed. Customers reply
 * above the quote, so everything from the first quote marker onwards is noise
 * that would otherwise be fed to the model as if the customer had written it.
 */
export function stripQuotedText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*(>|On .+ wrote:|-{2,}\s*Original Message|_{5,})/i.test(line)) break;
    if (/^\s*From:\s.+<.+@.+>/i.test(line) && kept.length > 0) break;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, MAX_BODY_CHARS);
}

function toInbound(mail: ParsedMail, uid: number): InboundEmail {
  const from = mail.from?.value?.[0];
  const to = Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : [];
  const toAddresses = to.flatMap((entry) => entry.value.map((v) => v.address ?? '')).filter(Boolean);

  const headers: Record<string, string> = {};
  for (const name of [
    'auto-submitted',
    'x-autoreply',
    'x-autorespond',
    'x-auto-response-suppress',
    'precedence',
    'content-type',
    'return-path',
  ]) {
    const value = headerString(mail, name);
    if (value) headers[name] = value;
  }

  const html = typeof mail.html === 'string' ? mail.html.replace(/<[^>]+>/g, ' ') : '';
  const text = stripQuotedText(mail.text ?? html);

  return {
    key: mail.messageId ?? `uid:${uid}`,
    uid,
    rfcMessageId: mail.messageId ?? null,
    inReplyTo: mail.inReplyTo ?? null,
    references: Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? [mail.references]
        : [],
    fromAddress: (from?.address ?? '').toLowerCase(),
    fromName: from?.name ?? '',
    toAddresses,
    subject: mail.subject ?? '(no subject)',
    text,
    date: mail.date ?? new Date(),
    headers,
  };
}

export interface InboxReader {
  readonly available: boolean;
  fetchUnseen(limit?: number): Promise<InboundEmail[]>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}

class ImapReader implements InboxReader {
  readonly available = true;

  private client(): ImapFlow {
    return new ImapFlow({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: env.IMAP_SECURE,
      auth: { user: env.IMAP_USER, pass: env.IMAP_PASS },
      logger: false,
    });
  }

  async fetchUnseen(limit = 25): Promise<InboundEmail[]> {
    const client = this.client();
    const found: InboundEmail[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
      try {
        const uids = await client.search({ seen: false });
        const recent = (uids || []).slice(-limit);
        for (const uid of recent) {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message || !message.source) continue;
          const parsed = await simpleParser(message.source);
          found.push(toInbound(parsed, uid));
          // Marking seen here keeps a second poller from racing on the same
          // message; the database claim is still the authority on duplicates.
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return found;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = this.client();
      await client.connect();
      await client.logout();
      return { ok: true, detail: `Connected to ${env.IMAP_HOST}:${env.IMAP_PORT}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

class DisabledReader implements InboxReader {
  readonly available = false;
  async fetchUnseen(): Promise<InboundEmail[]> {
    return [];
  }
  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'IMAP is not configured. Set IMAP_HOST and IMAP_USER in .env.' };
  }
}

let reader: InboxReader | null = null;

export function getInboxReader(): InboxReader {
  if (reader) return reader;
  if (imapConfigured) {
    reader = new ImapReader();
  } else {
    logger.warn('IMAP is not configured; the inbox will not be polled');
    reader = new DisabledReader();
  }
  return reader;
}

/** Used by the tests to feed the agent a fixed set of replies. */
export function setInboxReader(replacement: InboxReader | null): void {
  reader = replacement;
}

export { toInbound as parseInboundForTests };
