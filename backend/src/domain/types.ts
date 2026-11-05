import type { Currency } from './money.js';
import type { IsoDate } from './dates.js';

/** The stored status of an invoice. "Overdue" is never stored: it is derived. */
export type InvoiceStatus = 'draft' | 'sent' | 'paid';

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface Organization {
  name: string;
  address: string;
  accountsContactName: string;
  accountsEmail: string;
  phone: string;
  defaultCurrency: Currency;
  acceptedCurrencies: Currency[];
  paymentTerms: string;
  paymentMethods: string[];
  bankDetails: {
    accountName: string;
    accountNumber: string;
    bank: string;
    ifsc: string;
    swiftCode: string;
  };
  policies: Record<string, string>;
}

export interface Customer {
  customerId: string;
  name: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  city: string;
  country: string;
  currency: Currency;
  updatedAt?: Date;
}

export interface Invoice {
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  poNumber: string | null;
  invoiceDate: IsoDate;
  dueDate: IsoDate;
  paymentTerms: string;
  currency: Currency;
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxName: string;
  taxMinor: number;
  totalMinor: number;
  amountPaidMinor: number;
  balanceDueMinor: number;
  status: InvoiceStatus;
  /** Set when a reminder was last emailed, so the agent does not nag daily. */
  lastReminderAt?: Date | null;
  reminderCount?: number;
  updatedAt?: Date;
}

/** An invoice enriched with the facts the UI and the agent both need. */
export interface InvoiceView extends Invoice {
  isOverdue: boolean;
  daysOverdue: number;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageKind = 'reminder' | 'reply' | 'agent_answer' | 'manual_answer' | 'note';

export interface ConversationMessage {
  messageId: string;
  direction: MessageDirection;
  kind: MessageKind;
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Message-ID headers, kept so replies thread correctly in the customer's client. */
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  relatedInvoiceNumbers: string[];
  classification?: ReplyClassification | null;
  createdAt: Date;
}

export interface Conversation {
  conversationId: string;
  customerId: string;
  customerEmail: string;
  subject: string;
  messages: ConversationMessage[];
  lastMessageAt: Date;
  needsAttention: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The four behaviours the assignment asks the agent to distinguish. */
export type ReplyIntent =
  | 'balance_or_payment_question'
  | 'payment_claim'
  | 'extension_dispute_or_legal'
  | 'other_company_or_unknown'
  | 'out_of_office'
  | 'bounce'
  | 'unclear';

export interface ReplyClassification {
  intent: ReplyIntent;
  confidence: number;
  reasoning: string;
  /** Claims like "we paid INV-1004, reference N123456789", used as recon evidence. */
  claimedInvoiceNumbers: string[];
  claimedReference: string | null;
  claimedPaymentDate: IsoDate | null;
  promisedPaymentDate: IsoDate | null;
  source: 'llm' | 'rules';
}

export type AttentionStatus = 'open' | 'resolved' | 'dismissed';

export interface AttentionItem {
  itemId: string;
  conversationId: string | null;
  customerId: string | null;
  customerName: string;
  fromAddress: string;
  subject: string;
  incomingBody: string;
  /** The agent's suggested reply, which a person may edit before sending. */
  draftBody: string;
  reason: string;
  intent: ReplyIntent;
  confidence: number;
  validationIssues: string[];
  status: AttentionStatus;
  createdAt: Date;
  resolvedAt?: Date | null;
}

export interface StatementRowInput {
  txnDate: IsoDate;
  narration: string;
  reference: string | null;
  creditMinor: number | null;
  debitMinor: number | null;
  currency: Currency;
}

export type AllocationChoice = 'close_tds' | 'leave_open';

export interface SuggestedAllocation {
  invoiceNumber: string;
  amountMinor: number;
}

export interface MatchSuggestion {
  /** One or more invoices; more than one when a single receipt covers several. */
  allocations: SuggestedAllocation[];
  /** 0-100, as shown in the review screen. */
  score: number;
  reason: string;
  evidence: string[];
  /** Short payment that exactly matches total minus 10% TDS on the subtotal. */
  tdsConsistent: boolean;
  shortfallMinor: number;
  customerId: string | null;
  rerankedByLlm?: boolean;
}

export type StatementLineStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'ignored';

export interface StatementLine {
  lineId: string;
  batchId: string;
  rowNumber: number;
  txnDate: IsoDate;
  narration: string;
  reference: string | null;
  creditMinor: number | null;
  debitMinor: number | null;
  currency: Currency;
  /** Debits, bank interest and charges are not customer receipts. */
  isReceipt: boolean;
  nonReceiptReason: string | null;
  suggestion: MatchSuggestion | null;
  alternatives: MatchSuggestion[];
  /** Emails in which a customer claimed this payment, used as extra evidence. */
  linkedMessages: Array<{
    conversationId: string;
    messageId: string;
    customerId: string;
    snippet: string;
    reference: string | null;
  }>;
  status: StatementLineStatus;
  decision: {
    decidedAt: Date;
    allocations: SuggestedAllocation[];
    choice: AllocationChoice | null;
    note: string | null;
  } | null;
  createdAt: Date;
}

export interface ReconciliationBatch {
  batchId: string;
  filename: string;
  rowCount: number;
  receiptCount: number;
  uploadedAt: Date;
}

export interface Payment {
  paymentId: string;
  batchId: string;
  lineId: string;
  invoiceNumber: string;
  customerId: string;
  amountMinor: number;
  currency: Currency;
  txnDate: IsoDate;
  narration: string;
  reference: string | null;
  /** Set when the remaining balance was written off as TDS withheld. */
  tdsWriteOffMinor: number;
  choice: AllocationChoice | null;
  createdAt: Date;
}

/** IMAP message UIDs already handled, so a reply is never answered twice. */
export interface ProcessedEmail {
  key: string;
  mailbox: string;
  processedAt: Date;
}
