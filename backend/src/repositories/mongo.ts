import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type {
  AttentionItem,
  Conversation,
  Customer,
  Invoice,
  Organization,
  Payment,
  ProcessedEmail,
  ReconciliationBatch,
  StatementLine,
} from '../domain/types.js';

/**
 * The only module that knows MongoDB exists. Everything above it works with
 * domain objects, so swapping the store or adding caching stays a local change.
 */

let client: MongoClient | null = null;
let database: Db | null = null;

export const COLLECTIONS = {
  organization: 'organization',
  customers: 'customers',
  invoices: 'invoices',
  conversations: 'conversations',
  attention: 'attention_items',
  batches: 'reconciliation_batches',
  statementLines: 'statement_lines',
  payments: 'payments',
  processedEmails: 'processed_emails',
} as const;

export async function connectToDatabase(): Promise<Db> {
  if (database) return database;
  client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });
  await client.connect();
  database = client.db(env.MONGODB_DB);
  await ensureIndexes(database);
  logger.info({ db: env.MONGODB_DB }, 'connected to MongoDB');
  return database;
}

export function getDb(): Db {
  if (!database) throw new Error('The database is not connected yet.');
  return database;
}

export async function closeDatabase(): Promise<void> {
  await client?.close();
  client = null;
  database = null;
}

/**
 * Indexes are declared here rather than left to chance. The unique ones are
 * doing real work: they are what stops a seed run from duplicating invoices and
 * what stops the same inbound email being processed twice by two pollers.
 */
async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(COLLECTIONS.customers).createIndex({ customerId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.customers).createIndex({ contactEmail: 1 }),
    db.collection(COLLECTIONS.invoices).createIndex({ invoiceNumber: 1 }, { unique: true }),
    db.collection(COLLECTIONS.invoices).createIndex({ customerId: 1, status: 1 }),
    db.collection(COLLECTIONS.invoices).createIndex({ status: 1, dueDate: 1 }),
    db.collection(COLLECTIONS.conversations).createIndex({ conversationId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.conversations).createIndex({ customerId: 1, lastMessageAt: -1 }),
    db.collection(COLLECTIONS.attention).createIndex({ itemId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.attention).createIndex({ status: 1, createdAt: -1 }),
    db.collection(COLLECTIONS.batches).createIndex({ batchId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.statementLines).createIndex({ lineId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.statementLines).createIndex({ batchId: 1, rowNumber: 1 }),
    db.collection(COLLECTIONS.payments).createIndex({ paymentId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.payments).createIndex({ invoiceNumber: 1 }),
    // One decision per statement line, enforced by the database rather than by
    // a check in application code that a double click could race past.
    db.collection(COLLECTIONS.payments).createIndex({ lineId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.processedEmails).createIndex({ key: 1 }, { unique: true }),
  ]);
}

export const collections = {
  organization: () => getDb().collection<Organization>(COLLECTIONS.organization),
  customers: () => getDb().collection<Customer>(COLLECTIONS.customers),
  invoices: () => getDb().collection<Invoice>(COLLECTIONS.invoices),
  conversations: () => getDb().collection<Conversation>(COLLECTIONS.conversations),
  attention: () => getDb().collection<AttentionItem>(COLLECTIONS.attention),
  batches: () => getDb().collection<ReconciliationBatch>(COLLECTIONS.batches),
  statementLines: () => getDb().collection<StatementLine>(COLLECTIONS.statementLines),
  payments: () => getDb().collection<Payment>(COLLECTIONS.payments),
  processedEmails: () => getDb().collection<ProcessedEmail>(COLLECTIONS.processedEmails),
};
