import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { collections } from './mongo.js';
import type {
  AttentionItem,
  Conversation,
  ConversationMessage,
  Customer,
  Invoice,
  Organization,
  Payment,
  ReconciliationBatch,
  StatementLine,
  StatementLineStatus,
} from '../domain/types.js';

/**
 * Data access. Each function returns plain domain objects with the Mongo `_id`
 * stripped, so nothing above this layer ever sees a database identifier.
 */

function strip<T>(doc: (T & { _id?: unknown }) | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  void _id;
  return rest as T;
}

function stripAll<T>(docs: Array<T & { _id?: unknown }>): T[] {
  return docs.map((doc) => strip<T>(doc)!);
}

export const organizationRepo = {
  async get(): Promise<Organization | null> {
    return strip(await collections.organization().findOne({})) as Organization | null;
  },
  async replace(organization: Organization): Promise<void> {
    await collections.organization().deleteMany({});
    await collections.organization().insertOne(organization);
  },
  async updateAccountsEmail(email: string): Promise<Organization | null> {
    await collections.organization().updateOne({}, { $set: { accountsEmail: email } });
    return organizationRepo.get();
  },
};

export const customerRepo = {
  async list(): Promise<Customer[]> {
    const docs = await collections.customers().find({}).sort({ customerId: 1 }).toArray();
    return stripAll<Customer>(docs);
  },
  async findById(customerId: string): Promise<Customer | null> {
    return strip(await collections.customers().findOne({ customerId })) as Customer | null;
  },
  /** Email lookup is case-insensitive but anchored, never a loose regex search. */
  async findByEmail(email: string): Promise<Customer | null> {
    const normalized = email.trim().toLowerCase();
    const docs = await collections.customers().find({}).toArray();
    const found = docs.find((c) => c.contactEmail.trim().toLowerCase() === normalized) ?? null;
    return strip(found) as Customer | null;
  },
  async updateEmail(customerId: string, contactEmail: string): Promise<Customer | null> {
    await collections
      .customers()
      .updateOne({ customerId }, { $set: { contactEmail, updatedAt: new Date() } });
    return customerRepo.findById(customerId);
  },
  async replaceAll(customers: Customer[]): Promise<void> {
    await collections.customers().deleteMany({});
    if (customers.length > 0) await collections.customers().insertMany(customers);
  },
};

export const invoiceRepo = {
  async list(filter: Filter<Invoice> = {}): Promise<Invoice[]> {
    const docs = await collections.invoices().find(filter).sort({ invoiceNumber: 1 }).toArray();
    return stripAll<Invoice>(docs);
  },
  async findByNumber(invoiceNumber: string): Promise<Invoice | null> {
    return strip(await collections.invoices().findOne({ invoiceNumber })) as Invoice | null;
  },
  async listForCustomer(customerId: string): Promise<Invoice[]> {
    return invoiceRepo.list({ customerId });
  },
  async listOutstanding(): Promise<Invoice[]> {
    return invoiceRepo.list({ status: 'sent', balanceDueMinor: { $gt: 0 } });
  },
  /**
   * Applies a receipt. The filter repeats the balance we read, so two approvals
   * racing on the same invoice cannot both succeed: the second finds the
   * balance changed and is rejected rather than paying the invoice twice.
   */
  async applyPayment(
    invoiceNumber: string,
    expectedBalanceMinor: number,
    update: { amountPaidMinor: number; balanceDueMinor: number; status: Invoice['status'] },
  ): Promise<boolean> {
    const result = await collections.invoices().updateOne(
      { invoiceNumber, balanceDueMinor: expectedBalanceMinor },
      { $set: { ...update, updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  },
  async markReminderSent(invoiceNumber: string): Promise<void> {
    await collections
      .invoices()
      .updateOne(
        { invoiceNumber },
        { $set: { lastReminderAt: new Date() }, $inc: { reminderCount: 1 } },
      );
  },
  async replaceAll(invoices: Invoice[]): Promise<void> {
    await collections.invoices().deleteMany({});
    if (invoices.length > 0) await collections.invoices().insertMany(invoices);
  },
};

export const conversationRepo = {
  async list(): Promise<Conversation[]> {
    const docs = await collections.conversations().find({}).sort({ lastMessageAt: -1 }).toArray();
    return stripAll<Conversation>(docs);
  },
  async findById(conversationId: string): Promise<Conversation | null> {
    return strip<Conversation>(await collections.conversations().findOne({ conversationId }));
  },
  async listForCustomer(customerId: string): Promise<Conversation[]> {
    const docs = await collections
      .conversations()
      .find({ customerId })
      .sort({ lastMessageAt: -1 })
      .toArray();
    return stripAll<Conversation>(docs);
  },
  /** One open conversation per customer, so a thread stays a thread. */
  async findOrCreate(customer: Customer, subject: string): Promise<Conversation> {
    const existing = await collections
      .conversations()
      .findOne({ customerId: customer.customerId }, { sort: { lastMessageAt: -1 } });
    if (existing) return strip(existing) as Conversation;

    const now = new Date();
    const conversation: Conversation = {
      conversationId: randomUUID(),
      customerId: customer.customerId,
      customerEmail: customer.contactEmail,
      subject,
      messages: [],
      lastMessageAt: now,
      needsAttention: false,
      createdAt: now,
      updatedAt: now,
    };
    await collections.conversations().insertOne(conversation);
    return conversation;
  },
  async appendMessage(conversationId: string, message: ConversationMessage): Promise<void> {
    await collections.conversations().updateOne(
      { conversationId },
      {
        $push: { messages: message },
        $set: { lastMessageAt: message.createdAt, updatedAt: new Date() },
      },
    );
  },
  async setNeedsAttention(conversationId: string, needsAttention: boolean): Promise<void> {
    await collections
      .conversations()
      .updateOne({ conversationId }, { $set: { needsAttention, updatedAt: new Date() } });
  },
  async deleteAll(): Promise<void> {
    await collections.conversations().deleteMany({});
  },
};

export const attentionRepo = {
  async list(status?: AttentionItem['status']): Promise<AttentionItem[]> {
    const filter = status ? { status } : {};
    const docs = await collections.attention().find(filter).sort({ createdAt: -1 }).toArray();
    return stripAll<AttentionItem>(docs);
  },
  async findById(itemId: string): Promise<AttentionItem | null> {
    return strip(await collections.attention().findOne({ itemId })) as AttentionItem | null;
  },
  async create(item: AttentionItem): Promise<AttentionItem> {
    await collections.attention().insertOne(item);
    return item;
  },
  async updateDraft(itemId: string, draftBody: string): Promise<void> {
    await collections.attention().updateOne({ itemId }, { $set: { draftBody } });
  },
  async close(itemId: string, status: Exclude<AttentionItem['status'], 'open'>): Promise<void> {
    await collections
      .attention()
      .updateOne({ itemId }, { $set: { status, resolvedAt: new Date() } });
  },
  async countOpen(): Promise<number> {
    return collections.attention().countDocuments({ status: 'open' });
  },
  async deleteAll(): Promise<void> {
    await collections.attention().deleteMany({});
  },
};

export const reconciliationRepo = {
  async createBatch(batch: ReconciliationBatch, lines: StatementLine[]): Promise<void> {
    await collections.batches().insertOne(batch);
    if (lines.length > 0) await collections.statementLines().insertMany(lines);
  },
  async listBatches(): Promise<ReconciliationBatch[]> {
    const docs = await collections.batches().find({}).sort({ uploadedAt: -1 }).toArray();
    return stripAll<ReconciliationBatch>(docs);
  },
  async findBatch(batchId: string): Promise<ReconciliationBatch | null> {
    return strip(await collections.batches().findOne({ batchId })) as ReconciliationBatch | null;
  },
  async listLines(batchId: string): Promise<StatementLine[]> {
    const docs = await collections
      .statementLines()
      .find({ batchId })
      .sort({ rowNumber: 1 })
      .toArray();
    return stripAll<StatementLine>(docs);
  },
  async findLine(lineId: string): Promise<StatementLine | null> {
    return strip(await collections.statementLines().findOne({ lineId })) as StatementLine | null;
  },
  /**
   * Moves a line out of `pending` only if it is still pending. The guard is the
   * filter, so a repeated approval is a no-op rather than a second payment.
   */
  async settleLine(
    lineId: string,
    status: StatementLineStatus,
    decision: StatementLine['decision'],
  ): Promise<boolean> {
    const result = await collections
      .statementLines()
      .updateOne({ lineId, status: 'pending' }, { $set: { status, decision } });
    return result.modifiedCount === 1;
  },
  async updateSuggestion(
    lineId: string,
    suggestion: StatementLine['suggestion'],
    alternatives: StatementLine['alternatives'],
  ): Promise<void> {
    await collections.statementLines().updateOne({ lineId }, { $set: { suggestion, alternatives } });
  },
  async linkMessages(lineId: string, links: StatementLine['linkedMessages']): Promise<void> {
    await collections.statementLines().updateOne({ lineId }, { $set: { linkedMessages: links } });
  },
  async deleteAll(): Promise<void> {
    await Promise.all([
      collections.batches().deleteMany({}),
      collections.statementLines().deleteMany({}),
    ]);
  },
};

export const paymentRepo = {
  async list(): Promise<Payment[]> {
    const docs = await collections.payments().find({}).sort({ createdAt: -1 }).toArray();
    return stripAll<Payment>(docs);
  },
  async listForInvoice(invoiceNumber: string): Promise<Payment[]> {
    const docs = await collections.payments().find({ invoiceNumber }).toArray();
    return stripAll<Payment>(docs);
  },
  async create(payments: Payment[]): Promise<void> {
    if (payments.length > 0) await collections.payments().insertMany(payments);
  },
  async deleteAll(): Promise<void> {
    await collections.payments().deleteMany({});
  },
};

export const processedEmailRepo = {
  /** Returns false when this message has already been handled. */
  async claim(key: string, mailbox: string): Promise<boolean> {
    try {
      await collections.processedEmails().insertOne({ key, mailbox, processedAt: new Date() });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  },
  async deleteAll(): Promise<void> {
    await collections.processedEmails().deleteMany({});
  },
};
