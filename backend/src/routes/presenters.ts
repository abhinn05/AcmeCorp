import { formatMoney, toMajor, type Currency } from '../domain/money.js';
import type {
  AttentionItem,
  Conversation,
  InvoiceView,
  MatchSuggestion,
  Payment,
  StatementLine,
} from '../domain/types.js';
import type { CustomerSummary } from '../services/catalog.js';

/**
 * Turning domain objects into what the API returns.
 *
 * Amounts cross the wire three ways: the integer minor units the application
 * works in, the major-unit number for anything that wants to do arithmetic, and
 * a formatted string. The front end never has to know how a rupee is grouped
 * differently from a dollar, and it never has to reconstruct a figure that the
 * back end already knows how to write.
 */

export interface MoneyDto {
  minor: number;
  amount: number;
  currency: Currency;
  formatted: string;
}

export function money(minor: number, currency: Currency): MoneyDto {
  return { minor, amount: toMajor(minor), currency, formatted: formatMoney(minor, currency) };
}

export function invoiceDto(invoice: InvoiceView) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    poNumber: invoice.poNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    paymentTerms: invoice.paymentTerms,
    currency: invoice.currency,
    status: invoice.status,
    isOverdue: invoice.isOverdue,
    daysOverdue: invoice.daysOverdue,
    subtotal: money(invoice.subtotalMinor, invoice.currency),
    discount: money(invoice.discountMinor, invoice.currency),
    taxName: invoice.taxName,
    tax: money(invoice.taxMinor, invoice.currency),
    total: money(invoice.totalMinor, invoice.currency),
    amountPaid: money(invoice.amountPaidMinor, invoice.currency),
    balanceDue: money(invoice.balanceDueMinor, invoice.currency),
    lineItems: invoice.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: money(item.unitPriceMinor, invoice.currency),
      amount: money(item.amountMinor, invoice.currency),
    })),
    lastReminderAt: invoice.lastReminderAt ?? null,
    reminderCount: invoice.reminderCount ?? 0,
  };
}

export function customerDto(customer: CustomerSummary) {
  return {
    customerId: customer.customerId,
    name: customer.name,
    contactName: customer.contactName,
    contactEmail: customer.contactEmail,
    phone: customer.phone,
    city: customer.city,
    country: customer.country,
    currency: customer.currency,
    invoiceCount: customer.invoiceCount,
    overdueCount: customer.overdueCount,
    oldestDueDate: customer.oldestDueDate,
    outstanding: money(customer.outstandingMinor, customer.currency),
    overdue: money(customer.overdueMinor, customer.currency),
  };
}

export function conversationDto(conversation: Conversation) {
  return {
    conversationId: conversation.conversationId,
    customerId: conversation.customerId,
    customerEmail: conversation.customerEmail,
    subject: conversation.subject,
    needsAttention: conversation.needsAttention,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messages.length,
    messages: conversation.messages.map((message) => ({
      messageId: message.messageId,
      direction: message.direction,
      kind: message.kind,
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      relatedInvoiceNumbers: message.relatedInvoiceNumbers,
      intent: message.classification?.intent ?? null,
      confidence: message.classification?.confidence ?? null,
      classifiedBy: message.classification?.source ?? null,
      createdAt: message.createdAt,
    })),
  };
}

export function attentionDto(item: AttentionItem) {
  return {
    itemId: item.itemId,
    conversationId: item.conversationId,
    customerId: item.customerId,
    customerName: item.customerName,
    fromAddress: item.fromAddress,
    subject: item.subject,
    incomingBody: item.incomingBody,
    draftBody: item.draftBody,
    reason: item.reason,
    intent: item.intent,
    confidence: item.confidence,
    validationIssues: item.validationIssues,
    status: item.status,
    createdAt: item.createdAt,
  };
}

function suggestionDto(suggestion: MatchSuggestion | null, currency: Currency) {
  if (!suggestion) return null;
  return {
    allocations: suggestion.allocations.map((allocation) => ({
      invoiceNumber: allocation.invoiceNumber,
      amount: money(allocation.amountMinor, currency),
    })),
    score: suggestion.score,
    reason: suggestion.reason,
    evidence: suggestion.evidence,
    tdsConsistent: suggestion.tdsConsistent,
    shortfall: money(suggestion.shortfallMinor, currency),
    customerId: suggestion.customerId,
    rerankedByLlm: suggestion.rerankedByLlm ?? false,
  };
}

export function statementLineDto(line: StatementLine) {
  return {
    lineId: line.lineId,
    batchId: line.batchId,
    rowNumber: line.rowNumber,
    txnDate: line.txnDate,
    narration: line.narration,
    reference: line.reference,
    currency: line.currency,
    credit: line.creditMinor === null ? null : money(line.creditMinor, line.currency),
    debit: line.debitMinor === null ? null : money(line.debitMinor, line.currency),
    isReceipt: line.isReceipt,
    nonReceiptReason: line.nonReceiptReason,
    status: line.status,
    suggestion: suggestionDto(line.suggestion, line.currency),
    alternatives: line.alternatives.map((alternative) => suggestionDto(alternative, line.currency)),
    linkedMessages: line.linkedMessages,
    decision: line.decision
      ? {
          decidedAt: line.decision.decidedAt,
          choice: line.decision.choice,
          note: line.decision.note,
          allocations: line.decision.allocations.map((allocation) => ({
            invoiceNumber: allocation.invoiceNumber,
            amount: money(allocation.amountMinor, line.currency),
          })),
        }
      : null,
  };
}

export function paymentDto(payment: Payment) {
  return {
    paymentId: payment.paymentId,
    invoiceNumber: payment.invoiceNumber,
    customerId: payment.customerId,
    txnDate: payment.txnDate,
    narration: payment.narration,
    reference: payment.reference,
    choice: payment.choice,
    amount: money(payment.amountMinor, payment.currency),
    tdsWriteOff: money(payment.tdsWriteOffMinor, payment.currency),
    createdAt: payment.createdAt,
  };
}
