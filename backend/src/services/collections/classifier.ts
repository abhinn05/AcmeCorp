import { isIsoDate, type IsoDate } from '../../domain/dates.js';
import type { ReplyClassification, ReplyIntent } from '../../domain/types.js';
import type { InboundEmail } from '../../integrations/imap.js';
import { getLlmClient } from '../../integrations/llm.js';
import { renderContextForPrompt, type CustomerContext } from './context.js';

/**
 * Deciding what a customer's reply is asking for, and drafting an answer.
 *
 * The model proposes; it does not dispose. Two things sit in front of it: an
 * automatic-reply check that never reaches it at all, and a confidence
 * threshold. Two things sit behind it: the draft validator, and the rule that
 * an intent needing judgement always goes to a person however confident the
 * model was.
 */

/** Intents the agent may answer on its own. Everything else goes to a person. */
export const AUTO_ANSWERABLE: ReadonlySet<ReplyIntent> = new Set<ReplyIntent>([
  'balance_or_payment_question',
  'payment_claim',
]);

/**
 * Out-of-office notices and delivery failures, recognised before anything else.
 *
 * These are machine mail. Answering one is at best noise and at worst a loop
 * between two autoresponders, so they are identified from the headers first
 * (which is where the answer actually is) and only then from the wording.
 */
export function detectAutomaticMail(email: InboundEmail): ReplyIntent | null {
  const headers = email.headers;
  const autoSubmitted = (headers['auto-submitted'] ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'out_of_office';
  if (headers['x-autoreply'] || headers['x-autorespond']) return 'out_of_office';
  if ((headers['precedence'] ?? '').toLowerCase() === 'auto_reply') return 'out_of_office';

  const from = email.fromAddress.toLowerCase();
  const subject = email.subject.toLowerCase();
  const body = email.text.toLowerCase();

  const bounceSender =
    from.startsWith('mailer-daemon@') ||
    from.startsWith('postmaster@') ||
    from === '' ||
    from.includes('no-reply@') ||
    from.includes('noreply@');
  const bounceSubject =
    /undeliverable|delivery (status notification|failure|has failed)|returned mail|mail delivery (failed|subsystem)|address not found/i.test(
      subject,
    );
  const bounceBody = /550 5\.\d\.\d|recipient address rejected|could not be delivered/i.test(body);
  if (bounceSubject || bounceBody || (bounceSender && /delivery|undeliver/i.test(subject))) {
    return 'bounce';
  }
  if ((headers['content-type'] ?? '').includes('report-type=delivery-status')) return 'bounce';

  const oooSubject = /out of (the )?office|automatic reply|auto[- ]?reply|on (annual )?leave|vacation/i;
  if (oooSubject.test(subject)) return 'out_of_office';
  if (/i am (currently )?(out of the office|on leave|away)/i.test(body)) return 'out_of_office';

  return null;
}

/**
 * A rules-only classification, used when no model is configured or when the
 * model call fails. It is deliberately cautious: anything it is not sure about
 * becomes `unclear`, which routes to a person rather than to an answer.
 */
export function classifyByRules(email: InboundEmail): ReplyClassification {
  const text = `${email.subject}\n${email.text}`.toLowerCase();
  const base = {
    reasoning: 'Classified by keyword rules because no model answer was available.',
    claimedInvoiceNumbers: extractInvoiceMentions(email.text),
    claimedReference: extractReference(email.text),
    claimedPaymentDate: null,
    promisedPaymentDate: null,
    source: 'rules' as const,
  };

  // Erring towards a person is the safe direction here: a wrongly escalated
  // question costs a click, a wrongly answered dispute costs a concession.
  if (
    /lawyer|legal|court|litigation|arbitration|legal notice|dispute|disputed|incorrect|wrong|overcharg|never ordered|did ?n[o']t order|do ?n[o']t owe|duplicate invoice|cancel(led)? (the )?order/.test(
      text,
    )
  ) {
    return { ...base, intent: 'extension_dispute_or_legal', confidence: 0.6 };
  }
  if (/extension|more time|instal?ment|defer|postpone|push (it )?back|grace period/.test(text)) {
    return { ...base, intent: 'extension_dispute_or_legal', confidence: 0.6 };
  }
  if (/\b(paid|payment (made|sent|done)|transferred|remitted|utr|neft ref)\b/.test(text)) {
    return { ...base, intent: 'payment_claim', confidence: 0.55 };
  }
  if (/\b(balance|outstanding|how much|invoice|statement|bank details|account number|ifsc|swift|how (do|can) (i|we) pay)\b/.test(text)) {
    return { ...base, intent: 'balance_or_payment_question', confidence: 0.5 };
  }
  return { ...base, intent: 'unclear', confidence: 0.3 };
}

export function extractInvoiceMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bINV[\s\-#]?0*(\d{3,6})\b/gi)) {
    found.add(`INV-${match[1]}`);
  }
  return [...found];
}

/** A payment reference quoted in a reply, used later as reconciliation evidence. */
export function extractReference(text: string): string | null {
  const labelled = text.match(
    /\b(?:ref(?:erence)?|utr|txn|transaction|rrn)\b[\s:#-]*([A-Z0-9][A-Z0-9-]{5,24})/i,
  );
  if (labelled?.[1]) return labelled[1].toUpperCase();
  const bare = text.match(/\b([A-Z]{1,4}\d{9,18}|\d{12,18})\b/);
  return bare?.[1] ? bare[1].toUpperCase() : null;
}

const SYSTEM_PROMPT = `You are the accounts receivable assistant for an organization, writing to one of its customers about unpaid invoices.

You will be given the organization's details, that one customer's outstanding invoices, and the customer's latest email.

Classify the email into exactly one intent:
- "balance_or_payment_question": they ask what they owe, about an invoice, or how and where to pay.
- "payment_claim": they say they have paid, or that they will pay on a particular date.
- "extension_dispute_or_legal": they ask for more time or an instalment plan, dispute an invoice or an amount, or mention lawyers, legal action or a formal notice.
- "other_company_or_unknown": the email is about a company other than the customer it came from, or the sender does not appear to be this customer.
- "unclear": you cannot tell.

Then write a reply. These rules are absolute:
1. Use ONLY the figures, dates and invoice numbers given to you. Never calculate a new figure, never estimate, never round, and never mention an invoice that is not in the list.
2. Copy amounts and dates exactly as they are written in the context, including the currency symbol and the format.
3. Never confirm that an invoice is paid, settled or closed. A payment is only confirmed once it has been checked against the bank, which is not your decision.
4. Never agree to a later payment date, an instalment plan, a discount, a waiver or a write-off, and never accept or reject a dispute.
5. Never mention any other customer, or anything about the organization that is not in the context given to you.
6. Write plainly and courteously, as an accounts team would. No marketing language, no emoji, no invented names.
7. Sign off with the accounts contact name and the organization name given in the context.

Reply with a single JSON object and nothing else:
{
  "intent": "<one of the five intents>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence on why>",
  "claimed_invoice_numbers": ["<invoice numbers the customer says they have paid, if any>"],
  "claimed_reference": "<the payment reference they quote, or null>",
  "claimed_payment_date": "<YYYY-MM-DD if they say they have already paid on a date, else null>",
  "promised_payment_date": "<YYYY-MM-DD if they promise to pay on a date, else null>",
  "subject": "<subject line for the reply>",
  "body": "<the full reply email>"
}`;

interface LlmReply {
  intent?: string;
  confidence?: number;
  reasoning?: string;
  claimed_invoice_numbers?: unknown;
  claimed_reference?: unknown;
  claimed_payment_date?: unknown;
  promised_payment_date?: unknown;
  subject?: unknown;
  body?: unknown;
}

const VALID_INTENTS: ReplyIntent[] = [
  'balance_or_payment_question',
  'payment_claim',
  'extension_dispute_or_legal',
  'other_company_or_unknown',
  'unclear',
];

function asIsoOrNull(value: unknown): IsoDate | null {
  return typeof value === 'string' && isIsoDate(value) ? value : null;
}

export interface DraftedReply {
  classification: ReplyClassification;
  subject: string;
  body: string;
  llmError: string | null;
}

/** Asks the model to classify the reply and draft an answer. */
export async function classifyAndDraft(
  email: InboundEmail,
  context: CustomerContext,
): Promise<DraftedReply> {
  const llm = getLlmClient();
  const fallback = (error: string | null): DraftedReply => ({
    classification: classifyByRules(email),
    subject: `Re: ${email.subject}`,
    body: '',
    llmError: error,
  });

  if (!llm.available) return fallback('No model is configured.');

  const user = [
    renderContextForPrompt(context),
    '',
    'THE CUSTOMER\'S EMAIL:',
    `  From: ${context.customer.contactName} <${email.fromAddress}>`,
    `  Subject: ${email.subject}`,
    '  Body:',
    // The customer's own words are fenced so that an instruction written inside
    // an email is read as part of the email, not as part of the prompt.
    '  """',
    email.text.slice(0, 6000),
    '  """',
  ].join('\n');

  const result = await llm.completeJson<LlmReply>({ system: SYSTEM_PROMPT, user });
  if (!result.ok || !result.data) return fallback(result.error);

  const data = result.data;
  const intent = VALID_INTENTS.includes(data.intent as ReplyIntent)
    ? (data.intent as ReplyIntent)
    : 'unclear';
  const confidence =
    typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1
      ? data.confidence
      : 0;

  const claimedFromModel = Array.isArray(data.claimed_invoice_numbers)
    ? data.claimed_invoice_numbers.filter((v): v is string => typeof v === 'string')
    : [];

  return {
    classification: {
      intent,
      confidence,
      reasoning: typeof data.reasoning === 'string' ? data.reasoning.slice(0, 400) : '',
      // The regex over the raw email is trusted over the model here: it cannot
      // hallucinate an invoice number the customer never wrote.
      claimedInvoiceNumbers: [
        ...new Set([...extractInvoiceMentions(email.text), ...claimedFromModel]),
      ],
      claimedReference:
        typeof data.claimed_reference === 'string' && data.claimed_reference.trim() !== ''
          ? data.claimed_reference.trim().toUpperCase().slice(0, 40)
          : extractReference(email.text),
      claimedPaymentDate: asIsoOrNull(data.claimed_payment_date),
      promisedPaymentDate: asIsoOrNull(data.promised_payment_date),
      source: 'llm',
    },
    subject:
      typeof data.subject === 'string' && data.subject.trim() !== ''
        ? data.subject.trim().slice(0, 200)
        : `Re: ${email.subject}`,
    body: typeof data.body === 'string' ? data.body.trim() : '',
    llmError: null,
  };
}
