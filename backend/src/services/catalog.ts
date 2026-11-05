import { today } from '../domain/dates.js';
import { isOverdue, toInvoiceView } from '../domain/invoice.js';
import type { Customer, InvoiceView, Organization } from '../domain/types.js';
import {
  attentionRepo,
  conversationRepo,
  customerRepo,
  invoiceRepo,
  organizationRepo,
  paymentRepo,
  processedEmailRepo,
  reconciliationRepo,
} from '../repositories/index.js';
import { loadCustomers, loadInvoices, loadOrganization } from './seedData.js';

/**
 * The read side of the base application, plus the demo reset.
 *
 * Overdue status and days overdue are computed here on every read rather than
 * stored, because they depend on today's date: a stored flag would be wrong by
 * the next morning and would need a job to keep it honest.
 */

export interface CustomerSummary extends Customer {
  invoiceCount: number;
  outstandingMinor: number;
  overdueMinor: number;
  overdueCount: number;
  oldestDueDate: string | null;
}

export async function getOrganization(): Promise<Organization | null> {
  return organizationRepo.get();
}

export async function listInvoices(filter?: {
  customerId?: string;
  status?: 'draft' | 'sent' | 'paid';
  overdueOnly?: boolean;
}): Promise<InvoiceView[]> {
  const asOf = today();
  const query: Record<string, unknown> = {};
  if (filter?.customerId) query['customerId'] = filter.customerId;
  if (filter?.status) query['status'] = filter.status;

  const invoices = await invoiceRepo.list(query);
  const views = invoices.map((invoice) => toInvoiceView(invoice, asOf));
  return filter?.overdueOnly ? views.filter((view) => view.isOverdue) : views;
}

export async function listCustomerSummaries(): Promise<CustomerSummary[]> {
  const asOf = today();
  const [customers, invoices] = await Promise.all([customerRepo.list(), invoiceRepo.list()]);

  return customers.map((customer) => {
    const mine = invoices.filter((invoice) => invoice.customerId === customer.customerId);
    const outstanding = mine.filter((i) => i.status === 'sent' && i.balanceDueMinor > 0);
    const overdue = outstanding.filter((invoice) => isOverdue(invoice, asOf));
    const oldest = overdue
      .map((invoice) => invoice.dueDate)
      .sort((a, b) => a.localeCompare(b))[0];

    return {
      ...customer,
      invoiceCount: mine.length,
      outstandingMinor: outstanding.reduce((sum, i) => sum + i.balanceDueMinor, 0),
      overdueMinor: overdue.reduce((sum, i) => sum + i.balanceDueMinor, 0),
      overdueCount: overdue.length,
      oldestDueDate: oldest ?? null,
    };
  });
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

export async function getDashboard(): Promise<Dashboard> {
  const asOf = today();
  const [invoices, customers, needsAttentionCount, conversations] = await Promise.all([
    invoiceRepo.list(),
    customerRepo.list(),
    attentionRepo.countOpen(),
    conversationRepo.list(),
  ]);

  const byCurrency = new Map<string, { outstandingMinor: number; overdueMinor: number }>();
  let overdueCount = 0;

  for (const invoice of invoices) {
    if (invoice.status !== 'sent' || invoice.balanceDueMinor <= 0) continue;
    const entry = byCurrency.get(invoice.currency) ?? { outstandingMinor: 0, overdueMinor: 0 };
    entry.outstandingMinor += invoice.balanceDueMinor;
    if (isOverdue(invoice, asOf)) {
      entry.overdueMinor += invoice.balanceDueMinor;
      overdueCount += 1;
    }
    byCurrency.set(invoice.currency, entry);
  }

  return {
    asOf,
    invoiceCount: invoices.length,
    outstandingByCurrency: [...byCurrency.entries()]
      .map(([currency, totals]) => ({ currency, ...totals }))
      .sort((a, b) => b.outstandingMinor - a.outstandingMinor),
    overdueCount,
    customerCount: customers.length,
    needsAttentionCount,
    conversationCount: conversations.length,
  };
}

/**
 * Restores the supplied data files and clears everything the demo produced.
 *
 * The customers' email addresses are the one thing worth keeping: whoever is
 * running the demo will have pointed them at their own inboxes, and making them
 * type those in again after every reset would be tedious. That behaviour is
 * optional and off by default so a reset really does mean "as supplied" unless
 * asked otherwise.
 */
export async function resetDemoData(options: { keepEmails?: boolean } = {}): Promise<{
  organization: Organization;
  customers: number;
  invoices: number;
}> {
  const existing = options.keepEmails ? await customerRepo.list() : [];
  const emailByCustomer = new Map(existing.map((c) => [c.customerId, c.contactEmail]));
  const existingOrganization = options.keepEmails ? await organizationRepo.get() : null;

  const organization = loadOrganization();
  if (existingOrganization?.accountsEmail) {
    organization.accountsEmail = existingOrganization.accountsEmail;
  }

  const customers = loadCustomers().map((customer) => {
    const kept = emailByCustomer.get(customer.customerId);
    return kept ? { ...customer, contactEmail: kept } : customer;
  });
  const invoices = loadInvoices();

  await Promise.all([
    organizationRepo.replace(organization),
    customerRepo.replaceAll(customers),
    invoiceRepo.replaceAll(invoices),
    conversationRepo.deleteAll(),
    attentionRepo.deleteAll(),
    reconciliationRepo.deleteAll(),
    paymentRepo.deleteAll(),
    processedEmailRepo.deleteAll(),
  ]);

  return { organization, customers: customers.length, invoices: invoices.length };
}
