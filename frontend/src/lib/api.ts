/**
 * The only module that talks to the back end.
 *
 * Every page goes through here, so there is one place that knows the URL shape,
 * one place that turns a failed response into an error a page can show, and no
 * component anywhere holding a credential: the API is the front end's entire
 * view of the system.
 */

export interface Money {
  minor: number;
  amount: number;
  currency: string;
  formatted: string;
}

export interface Invoice {
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  poNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  paymentTerms: string;
  currency: string;
  status: 'draft' | 'sent' | 'paid';
  isOverdue: boolean;
  daysOverdue: number;
  subtotal: Money;
  discount: Money;
  taxName: string;
  tax: Money;
  total: Money;
  amountPaid: Money;
  balanceDue: Money;
  lineItems: Array<{ description: string; quantity: number; unitPrice: Money; amount: Money }>;
  lastReminderAt: string | null;
  reminderCount: number;
}

export interface Customer {
  customerId: string;
  name: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  city: string;
  country: string;
  currency: string;
  invoiceCount: number;
  overdueCount: number;
  oldestDueDate: string | null;
  outstanding: Money;
  overdue: Money;
}

export type CustomerDetail = Omit<
  Customer,
  'invoiceCount' | 'overdueCount' | 'oldestDueDate' | 'outstanding' | 'overdue'
> & {
  invoices: Invoice[];
  conversations: Conversation[];
};

export interface Organization {
  name: string;
  address: string;
  accountsContactName: string;
  accountsEmail: string;
  phone: string;
  defaultCurrency: string;
  acceptedCurrencies: string[];
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

export interface Dashboard {
  asOf: string;
  invoiceCount: number;
  outstandingByCurrency: Array<{ currency: string; outstandingMinor: number; overdueMinor: number }>;
  overdueCount: number;
  customerCount: number;
  needsAttentionCount: number;
  conversationCount: number;
}

export interface ConversationMessage {
  messageId: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  relatedInvoiceNumbers: string[];
  intent: string | null;
  confidence: number | null;
  classifiedBy: string | null;
  createdAt: string;
}

export interface Conversation {
  conversationId: string;
  customerId: string;
  customerEmail: string;
  subject: string;
  needsAttention: boolean;
  lastMessageAt: string;
  messageCount: number;
  messages: ConversationMessage[];
}

export interface AttentionItem {
  itemId: string;
  conversationId: string | null;
  customerId: string | null;
  customerName: string;
  fromAddress: string;
  subject: string;
  incomingBody: string;
  draftBody: string;
  reason: string;
  intent: string;
  confidence: number;
  validationIssues: string[];
  status: string;
  createdAt: string;
}

export interface Suggestion {
  allocations: Array<{ invoiceNumber: string; amount: Money }>;
  score: number;
  reason: string;
  evidence: string[];
  tdsConsistent: boolean;
  shortfall: Money;
  customerId: string | null;
  rerankedByLlm: boolean;
}

export interface StatementLine {
  lineId: string;
  batchId: string;
  rowNumber: number;
  txnDate: string;
  narration: string;
  reference: string | null;
  currency: string;
  credit: Money | null;
  debit: Money | null;
  isReceipt: boolean;
  nonReceiptReason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'ignored';
  suggestion: Suggestion | null;
  alternatives: Suggestion[];
  linkedMessages: Array<{
    conversationId: string;
    messageId: string;
    customerId: string;
    snippet: string;
    reference: string | null;
  }>;
  decision: {
    decidedAt: string;
    choice: string | null;
    note: string | null;
    allocations: Array<{ invoiceNumber: string; amount: Money }>;
  } | null;
}

export interface Batch {
  batchId: string;
  filename: string;
  rowCount: number;
  receiptCount: number;
  uploadedAt: string;
}

export interface Health {
  status: string;
  today: string;
  timezone: string;
  mail: { transport: string; ok: boolean; detail: string };
  inbox: { available: boolean; ok: boolean; detail: string };
  llm: { configured: boolean; model: string | null };
  reconciliationRerank: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    let details: Array<{ field: string; message: string }> | undefined;
    try {
      const payload = (await response.json()) as { error?: string; details?: typeof details };
      if (payload.error) message = payload.error;
      details = payload.details;
    } catch {
      // A non-JSON error body is not worth reporting verbatim to a user.
    }
    throw new ApiError(response.status, message, details);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<Health>('/health'),
  dashboard: () => request<Dashboard>('/dashboard'),

  organization: () => request<Organization>('/organization'),
  updateAccountsEmail: (accountsEmail: string) =>
    request<Organization>('/organization/accounts-email', {
      method: 'PATCH',
      body: JSON.stringify({ accountsEmail }),
    }),

  customers: () => request<Customer[]>('/customers'),
  // The detail endpoint returns the customer's own fields plus their invoices
  // and threads. It does not repeat the list endpoint's rolled-up balances, so
  // the page derives those from the invoices it is given here.
  customer: (customerId: string) => request<CustomerDetail>(`/customers/${customerId}`),
  updateCustomerEmail: (customerId: string, contactEmail: string) =>
    request<Customer>(`/customers/${customerId}/email`, {
      method: 'PATCH',
      body: JSON.stringify({ contactEmail }),
    }),

  invoices: (params: { customerId?: string; status?: string; overdue?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.customerId) search.set('customerId', params.customerId);
    if (params.status) search.set('status', params.status);
    if (params.overdue) search.set('overdue', 'true');
    const query = search.toString();
    return request<Invoice[]>(`/invoices${query ? `?${query}` : ''}`);
  },
  invoice: (invoiceNumber: string) => request<Invoice>(`/invoices/${invoiceNumber}`),

  resetDemo: (keepEmails: boolean) =>
    request<{ message: string }>('/demo/reset', {
      method: 'POST',
      body: JSON.stringify({ keepEmails }),
    }),

  runReminders: (body: { customerId?: string; force?: boolean } = {}) =>
    request<{
      sent: Array<{ customerName: string; invoices: string[]; to: string }>;
      skipped: Array<{ customerId: string; reason: string }>;
      errors: Array<{ customerId: string; message: string }>;
    }>('/collections/reminders/run', { method: 'POST', body: JSON.stringify(body) }),

  checkInbox: () =>
    request<{
      fetched: number;
      answered: number;
      escalated: number;
      ignored: number;
      details: Array<{ from: string; subject: string; outcome: string; intent: string | null }>;
    }>('/collections/inbox/check', { method: 'POST' }),

  conversations: () => request<Conversation[]>('/collections/conversations'),
  attention: () => request<AttentionItem[]>('/collections/attention'),
  saveDraft: (itemId: string, draftBody: string) =>
    request<AttentionItem>(`/collections/attention/${itemId}/draft`, {
      method: 'PATCH',
      body: JSON.stringify({ draftBody }),
    }),
  sendReviewed: (itemId: string, body: string) =>
    request<{ sent: boolean; warnings: string[] }>(`/collections/attention/${itemId}/send`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  dismissAttention: (itemId: string) =>
    request<{ dismissed: boolean }>(`/collections/attention/${itemId}/dismiss`, { method: 'POST' }),

  uploadStatement: (file: File) => {
    const form = new FormData();
    form.append('statement', file);
    return request<{
      batch: Batch;
      parseErrors: Array<{ line: number; message: string }>;
      lines: StatementLine[];
    }>('/reconciliation/upload', { method: 'POST', body: form });
  },
  batches: () => request<Batch[]>('/reconciliation/batches'),
  batch: (batchId: string) =>
    request<{ batch: Batch; lines: StatementLine[] }>(`/reconciliation/batches/${batchId}`),
  lineChoices: (lineId: string) => request<Invoice[]>(`/reconciliation/lines/${lineId}/choices`),
  approveLine: (
    lineId: string,
    body: {
      allocations?: Array<{ invoiceNumber: string; amount: number }>;
      choice?: 'close_tds' | 'leave_open' | null;
      note?: string | null;
    },
  ) =>
    request<{ line: StatementLine; invoices: Invoice[] }>(
      `/reconciliation/lines/${lineId}/approve`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  rejectLine: (lineId: string, note?: string) =>
    request<StatementLine>(`/reconciliation/lines/${lineId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: note ?? null }),
    }),
};
