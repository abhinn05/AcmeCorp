import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { applyPayment } from '../domain/invoice.js';
import { formatMoney } from '../domain/money.js';
import type {
  AllocationChoice,
  Conversation,
  Invoice,
  MatchSuggestion,
  Payment,
  ReconciliationBatch,
  StatementLine,
  SuggestedAllocation,
} from '../domain/types.js';
import {
  conversationRepo,
  customerRepo,
  invoiceRepo,
  paymentRepo,
  reconciliationRepo,
} from '../repositories/index.js';
import { ReconciliationMatcher, CONFIDENT_THRESHOLD } from './matching/matcher.js';
import { parseStatementCsv } from './statementParser.js';
import { rerankWithLlm } from './matching/rerank.js';

/**
 * Bank reconciliation.
 *
 * An upload produces suggestions and nothing else. No invoice changes until a
 * person approves a line, and approving is the only path that writes a payment.
 * That separation is deliberate: the matcher is allowed to be wrong, because
 * being wrong costs a rejected suggestion rather than a corrupted ledger.
 */

export interface UploadResult {
  batch: ReconciliationBatch;
  lines: StatementLine[];
  parseErrors: Array<{ line: number; message: string }>;
}

export async function uploadStatement(filename: string, csv: string): Promise<UploadResult> {
  const { rows, errors } = parseStatementCsv(csv);
  const customers = await customerRepo.list();
  const invoices = await invoiceRepo.list();
  const matcher = new ReconciliationMatcher({ customers, invoices });

  const batchId = randomUUID();
  const now = new Date();
  const lines: StatementLine[] = [];

  for (const [index, row] of rows.entries()) {
    const classified = ReconciliationMatcher.classifyRow(row);
    let suggestion: MatchSuggestion | null = null;
    let alternatives: MatchSuggestion[] = [];
    let noMatchReason: string | null = classified.reason;

    if (classified.isReceipt) {
      const matched = matcher.match(row);
      suggestion = matched.best;
      alternatives = matched.alternatives;
      noMatchReason = matched.noMatchReason;
    }

    lines.push({
      lineId: randomUUID(),
      batchId,
      rowNumber: index + 1,
      txnDate: row.txnDate,
      narration: row.narration,
      reference: row.reference,
      creditMinor: row.creditMinor,
      debitMinor: row.debitMinor,
      currency: row.currency,
      isReceipt: classified.isReceipt,
      nonReceiptReason: classified.isReceipt ? noMatchReason : classified.reason,
      suggestion,
      alternatives,
      linkedMessages: [],
      status: classified.isReceipt ? 'pending' : 'ignored',
      decision: null,
      createdAt: now,
    });
  }

  const batch: ReconciliationBatch = {
    batchId,
    filename,
    rowCount: rows.length,
    receiptCount: lines.filter((line) => line.isReceipt).length,
    uploadedAt: now,
  };

  await reconciliationRepo.createBatch(batch, lines);

  // Bonus: a customer's email saying "we paid INV-1004, reference N123456789"
  // is evidence about a statement row, so it is attached to the row.
  await linkPaymentEmails(lines);

  // Optional, and off by default: ask a model to re-rank only the rows the
  // local algorithms left genuinely ambiguous. The matching never depends on it.
  if (env.RECON_LLM_RERANK) {
    await rerankAmbiguousLines(lines, invoices);
  }

  return { batch, lines: await reconciliationRepo.listLines(batchId), parseErrors: errors };
}

/**
 * Attaches customer emails that claim a payment to the statement rows they
 * could be about. A quoted bank reference matching the row is strong evidence;
 * failing that, the same customer and a date within a few days is enough to be
 * worth showing side by side.
 */
async function linkPaymentEmails(lines: StatementLine[]): Promise<void> {
  const conversations = await conversationRepo.list();
  if (conversations.length === 0) return;

  interface Claim {
    conversation: Conversation;
    messageId: string;
    customerId: string;
    reference: string | null;
    invoiceNumbers: string[];
    snippet: string;
    at: Date;
  }

  const claims: Claim[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      const classification = message.classification;
      if (message.direction !== 'inbound' || !classification) continue;
      if (classification.intent !== 'payment_claim') continue;
      claims.push({
        conversation,
        messageId: message.messageId,
        customerId: conversation.customerId,
        reference: classification.claimedReference,
        invoiceNumbers: classification.claimedInvoiceNumbers,
        snippet: message.body.slice(0, 280),
        at: message.createdAt,
      });
    }
  }
  if (claims.length === 0) return;

  for (const line of lines) {
    if (!line.isReceipt) continue;
    const suggestedCustomer = line.suggestion?.customerId ?? null;
    const suggestedInvoices = new Set(
      (line.suggestion?.allocations ?? []).map((a) => a.invoiceNumber),
    );

    const matches = claims.filter((claim) => {
      if (claim.reference && line.reference && claim.reference === line.reference.toUpperCase()) {
        return true;
      }
      if (claim.invoiceNumbers.some((number) => suggestedInvoices.has(number))) return true;
      if (suggestedCustomer && claim.customerId === suggestedCustomer) {
        const days = Math.abs(
          (claim.at.getTime() - new Date(`${line.txnDate}T00:00:00Z`).getTime()) / 86_400_000,
        );
        return days <= 7;
      }
      return false;
    });

    if (matches.length === 0) continue;

    await reconciliationRepo.linkMessages(
      line.lineId,
      matches.map((claim) => ({
        conversationId: claim.conversation.conversationId,
        messageId: claim.messageId,
        customerId: claim.customerId,
        snippet: claim.snippet,
        reference: claim.reference,
      })),
    );
    line.linkedMessages = matches.map((claim) => ({
      conversationId: claim.conversation.conversationId,
      messageId: claim.messageId,
      customerId: claim.customerId,
      snippet: claim.snippet,
      reference: claim.reference,
    }));

    // A customer naming the invoice themselves is independent corroboration, so
    // it lifts the confidence of a suggestion that already agrees with them.
    const corroborates = matches.some(
      (claim) =>
        claim.invoiceNumbers.some((number) => suggestedInvoices.has(number)) ||
        (claim.reference && line.reference && claim.reference === line.reference.toUpperCase()),
    );
    if (corroborates && line.suggestion && line.suggestion.score < 95) {
      const improved: MatchSuggestion = {
        ...line.suggestion,
        score: Math.min(97, line.suggestion.score + 8),
        evidence: [...line.suggestion.evidence, 'The customer emailed to say they paid this'],
      };
      await reconciliationRepo.updateSuggestion(line.lineId, improved, line.alternatives);
      line.suggestion = improved;
    }
  }
}

/** Rows where the local matcher could not separate two candidates. */
async function rerankAmbiguousLines(lines: StatementLine[], invoices: Invoice[]): Promise<void> {
  for (const line of lines) {
    if (!line.isReceipt || line.alternatives.length === 0) continue;
    const topScore = line.suggestion?.score ?? 0;
    if (topScore >= CONFIDENT_THRESHOLD) continue;

    try {
      const reranked = await rerankWithLlm(line, invoices);
      if (reranked) {
        await reconciliationRepo.updateSuggestion(line.lineId, reranked, line.alternatives);
        line.suggestion = reranked;
      }
    } catch (error) {
      logger.warn({ err: error, lineId: line.lineId }, 'LLM re-rank failed; keeping local result');
    }
  }
}

export interface ApproveInput {
  lineId: string;
  /** Overrides the suggestion when a person picks a different invoice. */
  allocations?: SuggestedAllocation[];
  choice?: AllocationChoice | null;
  note?: string | null;
}

export interface ApproveResult {
  line: StatementLine;
  payments: Payment[];
  invoices: Invoice[];
}

/**
 * Applies an approved receipt.
 *
 * The order matters: the statement line is claimed first, so a double click
 * cannot create two payments, and each invoice update is conditional on the
 * balance we read still being the balance in the database. If an invoice has
 * moved underneath us the whole approval is reported as a conflict rather than
 * half-applied.
 */
export async function approveLine(input: ApproveInput): Promise<ApproveResult> {
  const line = await reconciliationRepo.findLine(input.lineId);
  if (!line) throw Object.assign(new Error('That statement row does not exist.'), { status: 404 });
  if (line.status !== 'pending') {
    throw Object.assign(new Error('That row has already been decided.'), { status: 409 });
  }
  if (!line.isReceipt || line.creditMinor === null) {
    throw Object.assign(new Error('That row is not a receipt, so it cannot be applied.'), {
      status: 400,
    });
  }

  const allocations = input.allocations?.length
    ? input.allocations
    : (line.suggestion?.allocations ?? []);
  if (allocations.length === 0) {
    throw Object.assign(new Error('Choose at least one invoice before approving.'), { status: 400 });
  }

  const allocatedTotal = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  if (allocatedTotal > line.creditMinor) {
    throw Object.assign(
      new Error(
        `The allocation of ${formatMoney(allocatedTotal, line.currency)} is more than the ${formatMoney(line.creditMinor, line.currency)} received.`,
      ),
      { status: 400 },
    );
  }

  // Load and check every invoice before writing anything.
  const loaded: Array<{ invoice: Invoice; amountMinor: number }> = [];
  for (const allocation of allocations) {
    const invoice = await invoiceRepo.findByNumber(allocation.invoiceNumber);
    if (!invoice) {
      throw Object.assign(new Error(`Invoice ${allocation.invoiceNumber} does not exist.`), {
        status: 400,
      });
    }
    if (invoice.currency !== line.currency) {
      throw Object.assign(
        new Error(
          `${invoice.invoiceNumber} is in ${invoice.currency} but the receipt is in ${line.currency}.`,
        ),
        { status: 400 },
      );
    }
    if (invoice.status === 'draft') {
      throw Object.assign(
        new Error(`${invoice.invoiceNumber} is a draft and has not been sent to the customer.`),
        { status: 400 },
      );
    }
    if (allocation.amountMinor <= 0) {
      throw Object.assign(new Error('An allocated amount must be more than zero.'), { status: 400 });
    }
    loaded.push({ invoice, amountMinor: allocation.amountMinor });
  }

  // Claim the line first: this is the lock that makes the rest safe to repeat.
  const claimed = await reconciliationRepo.settleLine(line.lineId, 'approved', {
    decidedAt: new Date(),
    allocations,
    choice: input.choice ?? null,
    note: input.note ?? null,
  });
  if (!claimed) {
    throw Object.assign(new Error('That row was decided by someone else a moment ago.'), {
      status: 409,
    });
  }

  const payments: Payment[] = [];
  const updated: Invoice[] = [];

  for (const { invoice, amountMinor } of loaded) {
    const closeAsTds = input.choice === 'close_tds';
    const next = applyPayment(invoice, amountMinor, closeAsTds);
    const applied = await invoiceRepo.applyPayment(invoice.invoiceNumber, invoice.balanceDueMinor, {
      amountPaidMinor: next.amountPaidMinor,
      balanceDueMinor: next.balanceDueMinor,
      status: next.status,
    });
    if (!applied) {
      // Put the line back so the person can retry against the current figures.
      await reconciliationRepo.settleLine(line.lineId, 'pending', null);
      throw Object.assign(
        new Error(
          `${invoice.invoiceNumber} changed while this was being approved. Reload and try again.`,
        ),
        { status: 409 },
      );
    }

    payments.push({
      paymentId: randomUUID(),
      batchId: line.batchId,
      lineId: line.lineId,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      amountMinor,
      currency: line.currency,
      txnDate: line.txnDate,
      narration: line.narration,
      reference: line.reference,
      tdsWriteOffMinor: next.tdsWriteOffMinor,
      choice: input.choice ?? null,
      createdAt: new Date(),
    });
    updated.push({ ...invoice, ...next });
  }

  await paymentRepo.create(payments);

  const refreshed = await reconciliationRepo.findLine(line.lineId);
  return { line: refreshed ?? line, payments, invoices: updated };
}

export async function rejectLine(lineId: string, note?: string | null): Promise<StatementLine> {
  const line = await reconciliationRepo.findLine(lineId);
  if (!line) throw Object.assign(new Error('That statement row does not exist.'), { status: 404 });
  if (line.status !== 'pending') {
    throw Object.assign(new Error('That row has already been decided.'), { status: 409 });
  }
  await reconciliationRepo.settleLine(lineId, 'rejected', {
    decidedAt: new Date(),
    allocations: [],
    choice: null,
    note: note ?? null,
  });
  return (await reconciliationRepo.findLine(lineId))!;
}

/** The open invoices a person can choose from when the suggestion is wrong. */
export async function invoiceChoicesFor(lineId: string): Promise<Invoice[]> {
  const line = await reconciliationRepo.findLine(lineId);
  if (!line) throw Object.assign(new Error('That statement row does not exist.'), { status: 404 });
  const invoices = await invoiceRepo.listOutstanding();
  return invoices
    .filter((invoice) => invoice.currency === line.currency)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
