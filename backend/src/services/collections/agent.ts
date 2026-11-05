import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { daysBetween, today } from '../../domain/dates.js';
import { isOverdue } from '../../domain/invoice.js';
import type {
  AttentionItem,
  Conversation,
  ConversationMessage,
  Customer,
  Invoice,
  Organization,
  ReplyClassification,
  ReplyIntent,
} from '../../domain/types.js';
import { getInboxReader, type InboundEmail } from '../../integrations/imap.js';
import { getMailer } from '../../integrations/mailer.js';
import {
  attentionRepo,
  conversationRepo,
  customerRepo,
  invoiceRepo,
  organizationRepo,
  processedEmailRepo,
} from '../../repositories/index.js';
import { buildCustomerContext } from './context.js';
import { renderFallbackAnswer, renderReminder } from './templates.js';
import { AUTO_ANSWERABLE, classifyAndDraft, classifyByRules, detectAutomaticMail } from './classifier.js';
import { describeIssues, validateDraft } from './validator.js';

/**
 * The collections agent.
 *
 * It does two things on a schedule: it chases overdue invoices, and it reads
 * the replies that come back. The second is where the care is. A reply is only
 * answered without a person when all of the following hold: the sender is a
 * known customer, the message is not machine-generated, the intent is one of
 * the routine ones, the model was confident, and the draft passed validation
 * against the database. If any of those fails the message goes to the Needs
 * attention list with the draft attached, so a person always has somewhere to
 * start from and nothing goes out unchecked.
 */

export interface ReminderRunResult {
  sent: Array<{ customerId: string; customerName: string; invoices: string[]; to: string }>;
  skipped: Array<{ customerId: string; reason: string }>;
  errors: Array<{ customerId: string; message: string }>;
}

export interface InboxRunResult {
  fetched: number;
  answered: number;
  escalated: number;
  ignored: number;
  details: Array<{ from: string; subject: string; outcome: string; intent: ReplyIntent | null }>;
}

function newMessage(
  partial: Omit<ConversationMessage, 'messageId' | 'createdAt'> & { createdAt?: Date },
): ConversationMessage {
  return {
    messageId: randomUUID(),
    createdAt: partial.createdAt ?? new Date(),
    ...partial,
  };
}

/**
 * Sends reminders for overdue invoices.
 *
 * One email per customer rather than one per invoice: a customer with three
 * overdue invoices should get a single statement of what they owe, not three
 * separate chases on the same morning. A customer is left alone for a few days
 * after a reminder, which is what `REMINDER_MIN_INTERVAL_DAYS` is for.
 */
export async function runReminderSweep(
  options: { customerId?: string; invoiceNumbers?: string[]; force?: boolean } = {},
): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { sent: [], skipped: [], errors: [] };
  const organization = await organizationRepo.get();
  if (!organization) throw new Error('No organization record. Run the seed script first.');

  const asOf = today();
  const customers = await customerRepo.list();
  const allInvoices = await invoiceRepo.listOutstanding();
  const mailer = getMailer();

  for (const customer of customers) {
    if (options.customerId && customer.customerId !== options.customerId) continue;

    let due = allInvoices.filter(
      (invoice) => invoice.customerId === customer.customerId && isOverdue(invoice, asOf),
    );
    if (options.invoiceNumbers?.length) {
      due = due.filter((invoice) => options.invoiceNumbers!.includes(invoice.invoiceNumber));
    }
    if (due.length === 0) {
      if (options.customerId) {
        result.skipped.push({ customerId: customer.customerId, reason: 'nothing overdue' });
      }
      continue;
    }

    if (!options.force) {
      const chasedRecently = due.every((invoice) => {
        if (!invoice.lastReminderAt) return false;
        const days = daysBetween(asOf, invoice.lastReminderAt.toISOString().slice(0, 10));
        return days < env.REMINDER_MIN_INTERVAL_DAYS;
      });
      if (chasedRecently) {
        result.skipped.push({
          customerId: customer.customerId,
          reason: `reminded within the last ${env.REMINDER_MIN_INTERVAL_DAYS} days`,
        });
        continue;
      }
    }

    const { subject, body } = renderReminder(organization, customer, due, asOf);
    try {
      const conversation = await conversationRepo.findOrCreate(customer, subject);
      const sent = await mailer.send({ to: customer.contactEmail, subject, text: body });
      await conversationRepo.appendMessage(
        conversation.conversationId,
        newMessage({
          direction: 'outbound',
          kind: 'reminder',
          from: organization.accountsEmail,
          to: customer.contactEmail,
          subject,
          body,
          rfcMessageId: sent.messageId,
          inReplyTo: null,
          relatedInvoiceNumbers: due.map((i) => i.invoiceNumber),
          classification: null,
        }),
      );
      for (const invoice of due) await invoiceRepo.markReminderSent(invoice.invoiceNumber);

      result.sent.push({
        customerId: customer.customerId,
        customerName: customer.name,
        invoices: due.map((i) => i.invoiceNumber),
        to: customer.contactEmail,
      });
    } catch (error) {
      logger.error({ err: error, customerId: customer.customerId }, 'reminder failed to send');
      result.errors.push({ customerId: customer.customerId, message: (error as Error).message });
    }
  }
  return result;
}

async function escalate(params: {
  conversation: Conversation | null;
  customer: Customer | null;
  email: InboundEmail;
  draftBody: string;
  reason: string;
  classification: ReplyClassification;
  issues: string[];
}): Promise<AttentionItem> {
  const item: AttentionItem = {
    itemId: randomUUID(),
    conversationId: params.conversation?.conversationId ?? null,
    customerId: params.customer?.customerId ?? null,
    customerName: params.customer?.name ?? (params.email.fromName || params.email.fromAddress),
    fromAddress: params.email.fromAddress,
    subject: params.email.subject,
    incomingBody: params.email.text,
    draftBody: params.draftBody,
    reason: params.reason,
    intent: params.classification.intent,
    confidence: params.classification.confidence,
    validationIssues: params.issues,
    status: 'open',
    createdAt: new Date(),
    resolvedAt: null,
  };
  await attentionRepo.create(item);
  if (params.conversation) {
    await conversationRepo.setNeedsAttention(params.conversation.conversationId, true);
  }
  return item;
}

/** Why a reply with this intent cannot be answered automatically. */
function escalationReason(intent: ReplyIntent): string {
  switch (intent) {
    case 'extension_dispute_or_legal':
      return 'Asks for more time, disputes an invoice or mentions legal action. Only a person may respond to this.';
    case 'other_company_or_unknown':
      return 'Asks about another company, or the sender does not match the customer. Nothing has been shared.';
    case 'out_of_office':
      return 'Automatic out-of-office notice. No reply was sent.';
    case 'bounce':
      return 'Delivery failure notice. The address may be wrong.';
    default:
      return 'The agent was not confident enough to answer this without a person.';
  }
}

/**
 * Reads the inbox once and deals with everything in it. Safe to call from the
 * poller and from the "Check inbox now" button at the same time: each message
 * is claimed in the database before it is processed, so only one run handles it.
 */
export async function runInboxCheck(): Promise<InboxRunResult> {
  const result: InboxRunResult = { fetched: 0, answered: 0, escalated: 0, ignored: 0, details: [] };

  const organization = await organizationRepo.get();
  if (!organization) throw new Error('No organization record. Run the seed script first.');

  const reader = getInboxReader();
  if (!reader.available) return result;

  const emails = await reader.fetchUnseen();
  result.fetched = emails.length;
  if (emails.length === 0) return result;

  const customers = await customerRepo.list();
  const mailer = getMailer();

  for (const email of emails) {
    const claimed = await processedEmailRepo.claim(email.key, env.IMAP_MAILBOX);
    if (!claimed) {
      result.ignored += 1;
      continue;
    }
    try {
      const outcome = await handleInboundEmail(email, organization, customers, mailer);
      result.details.push(outcome);
      if (outcome.outcome === 'answered') result.answered += 1;
      else if (outcome.outcome === 'ignored') result.ignored += 1;
      else result.escalated += 1;
    } catch (error) {
      logger.error({ err: error, from: email.fromAddress }, 'failed to handle an inbound email');
      result.escalated += 1;
      result.details.push({
        from: email.fromAddress,
        subject: email.subject,
        outcome: 'error',
        intent: null,
      });
    }
  }
  return result;
}

async function handleInboundEmail(
  email: InboundEmail,
  organization: Organization,
  customers: Customer[],
  mailer: ReturnType<typeof getMailer>,
): Promise<{ from: string; subject: string; outcome: string; intent: ReplyIntent | null }> {
  const base = { from: email.fromAddress, subject: email.subject };

  // 1. Machine mail never reaches the model and is never answered.
  const automatic = detectAutomaticMail(email);
  const customer = await customerRepo.findByEmail(email.fromAddress);

  if (automatic) {
    const conversation = customer
      ? await conversationRepo.findOrCreate(customer, email.subject)
      : null;
    if (conversation) {
      await conversationRepo.appendMessage(
        conversation.conversationId,
        newMessage({
          direction: 'inbound',
          kind: 'note',
          from: email.fromAddress,
          to: organization.accountsEmail,
          subject: email.subject,
          body: email.text,
          rfcMessageId: email.rfcMessageId,
          inReplyTo: email.inReplyTo,
          relatedInvoiceNumbers: [],
          classification: {
            intent: automatic,
            confidence: 1,
            reasoning:
              automatic === 'bounce'
                ? 'Delivery failure notice, recognised from the headers.'
                : 'Automatic out-of-office notice, recognised from the headers.',
            claimedInvoiceNumbers: [],
            claimedReference: null,
            claimedPaymentDate: null,
            promisedPaymentDate: null,
            source: 'rules',
          },
        }),
      );
    }
    // A bounce means the address is wrong, which a person should know about.
    if (automatic === 'bounce') {
      await escalate({
        conversation,
        customer,
        email,
        draftBody: '',
        reason: escalationReason('bounce'),
        classification: { ...classifyByRules(email), intent: 'bounce', confidence: 1 },
        issues: [],
      });
      return { ...base, outcome: 'escalated', intent: 'bounce' };
    }
    return { ...base, outcome: 'ignored', intent: automatic };
  }

  // 2. An unknown sender is told nothing at all. No context is built for them,
  //    so there is nothing a crafted email could persuade the agent to reveal.
  if (!customer) {
    const classification: ReplyClassification = {
      ...classifyByRules(email),
      intent: 'other_company_or_unknown',
      confidence: 1,
    };
    await escalate({
      conversation: null,
      customer: null,
      email,
      draftBody: '',
      reason: 'Unknown sender. No account information has been shared.',
      classification,
      issues: [],
    });
    return { ...base, outcome: 'escalated', intent: 'other_company_or_unknown' };
  }

  // 3. A known customer: build their context and attach the reply to their thread.
  const invoices = await invoiceRepo.listForCustomer(customer.customerId);
  const context = buildCustomerContext(organization, customer, invoices);
  const conversation = await conversationRepo.findOrCreate(customer, email.subject);

  const drafted = await classifyAndDraft(email, context);
  const { classification } = drafted;

  await conversationRepo.appendMessage(
    conversation.conversationId,
    newMessage({
      direction: 'inbound',
      kind: 'reply',
      from: email.fromAddress,
      to: organization.accountsEmail,
      subject: email.subject,
      body: email.text,
      rfcMessageId: email.rfcMessageId,
      inReplyTo: email.inReplyTo,
      relatedInvoiceNumbers: classification.claimedInvoiceNumbers,
      classification,
      createdAt: email.date,
    }),
  );

  const fallback = renderFallbackAnswer(organization, customer, context.outstanding);
  const draftBody = drafted.body.trim() === '' ? fallback.body : drafted.body;
  const draftSubject = drafted.subject || `Re: ${email.subject}`;

  // 4. Intents needing judgement go to a person regardless of confidence.
  if (!AUTO_ANSWERABLE.has(classification.intent)) {
    await escalate({
      conversation,
      customer,
      email,
      // Nothing is drafted for a dispute or an unknown-company question: a
      // half-written concession is worse than a blank page.
      draftBody: classification.intent === 'extension_dispute_or_legal' ? '' : draftBody,
      reason: escalationReason(classification.intent),
      classification,
      issues: [],
    });
    return { ...base, outcome: 'escalated', intent: classification.intent };
  }

  if (classification.confidence < env.AGENT_AUTOSEND_MIN_CONFIDENCE) {
    await escalate({
      conversation,
      customer,
      email,
      draftBody,
      reason: `Confidence ${Math.round(classification.confidence * 100)}% is below the ${Math.round(
        env.AGENT_AUTOSEND_MIN_CONFIDENCE * 100,
      )}% needed to answer automatically.`,
      classification,
      issues: [],
    });
    return { ...base, outcome: 'escalated', intent: classification.intent };
  }

  // 5. Every figure in the draft is checked against this customer's records.
  const validation = validateDraft(draftBody, context, { allCustomers: customers });
  if (!validation.ok) {
    logger.warn({ issues: validation.issues }, 'a drafted reply failed validation');
    await escalate({
      conversation,
      customer,
      email,
      draftBody,
      reason: describeIssues(validation.issues),
      classification,
      issues: validation.issues,
    });
    return { ...base, outcome: 'escalated', intent: classification.intent };
  }

  // 6. Clear to send.
  const sent = await mailer.send({
    to: customer.contactEmail,
    subject: draftSubject,
    text: draftBody,
    inReplyTo: email.rfcMessageId,
    references: [...email.references, email.rfcMessageId].filter((v): v is string => Boolean(v)),
  });

  await conversationRepo.appendMessage(
    conversation.conversationId,
    newMessage({
      direction: 'outbound',
      kind: 'agent_answer',
      from: organization.accountsEmail,
      to: customer.contactEmail,
      subject: draftSubject,
      body: draftBody,
      rfcMessageId: sent.messageId,
      inReplyTo: email.rfcMessageId,
      relatedInvoiceNumbers: context.outstanding.map((i) => i.invoiceNumber),
      classification,
    }),
  );

  // A payment claim is recorded as a note, never as a payment: only the bank
  // statement and a person's approval can settle an invoice.
  if (classification.intent === 'payment_claim') {
    const detail = [
      classification.claimedInvoiceNumbers.length > 0
        ? `Invoices named: ${classification.claimedInvoiceNumbers.join(', ')}`
        : 'No invoice named',
      classification.claimedReference ? `Reference quoted: ${classification.claimedReference}` : '',
      classification.promisedPaymentDate
        ? `Payment promised for ${classification.promisedPaymentDate}`
        : '',
      classification.claimedPaymentDate
        ? `Customer says they paid on ${classification.claimedPaymentDate}`
        : '',
    ]
      .filter(Boolean)
      .join('. ');

    await conversationRepo.appendMessage(
      conversation.conversationId,
      newMessage({
        direction: 'inbound',
        kind: 'note',
        from: 'system',
        to: organization.accountsEmail,
        subject: 'Payment claim noted',
        body: `The customer says a payment has been made or is coming. Nothing has been marked as paid; this will be confirmed against the bank statement. ${detail}`,
        relatedInvoiceNumbers: classification.claimedInvoiceNumbers,
        classification: null,
      }),
    );
  }

  return { ...base, outcome: 'answered', intent: classification.intent };
}

/**
 * Sends a reply a person has written or edited from the Needs attention list.
 * It is validated too: a human can still mistype an amount, and the check costs
 * nothing. Failures are reported back rather than blocking the send, because a
 * person may have a good reason to write something the rules do not expect.
 */
export async function sendReviewedReply(
  itemId: string,
  body: string,
  subjectOverride?: string,
): Promise<{ sent: boolean; warnings: string[] }> {
  const item = await attentionRepo.findById(itemId);
  if (!item) throw Object.assign(new Error('That item no longer exists.'), { status: 404 });
  if (item.status !== 'open') {
    throw Object.assign(new Error('That item has already been dealt with.'), { status: 409 });
  }
  if (!item.customerId) {
    throw Object.assign(
      new Error('This message is not from a known customer, so the agent will not reply to it.'),
      { status: 400 },
    );
  }

  const organization = await organizationRepo.get();
  const customer = await customerRepo.findById(item.customerId);
  if (!organization || !customer) throw new Error('The customer record is missing.');

  const invoices = await invoiceRepo.listForCustomer(customer.customerId);
  const context = buildCustomerContext(organization, customer, invoices);
  const customers = await customerRepo.list();
  const validation = validateDraft(body, context, { allCustomers: customers });

  const subject = subjectOverride?.trim() || `Re: ${item.subject}`;
  const sent = await getMailer().send({ to: customer.contactEmail, subject, text: body });

  const conversation = item.conversationId
    ? await conversationRepo.findById(item.conversationId)
    : await conversationRepo.findOrCreate(customer, subject);

  if (conversation) {
    await conversationRepo.appendMessage(
      conversation.conversationId,
      newMessage({
        direction: 'outbound',
        kind: 'manual_answer',
        from: organization.accountsEmail,
        to: customer.contactEmail,
        subject,
        body,
        rfcMessageId: sent.messageId,
        inReplyTo: null,
        relatedInvoiceNumbers: [],
        classification: null,
      }),
    );
    await conversationRepo.setNeedsAttention(conversation.conversationId, false);
  }
  await attentionRepo.close(itemId, 'resolved');

  return { sent: true, warnings: validation.issues };
}

export type { Invoice };
