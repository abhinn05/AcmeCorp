import { formatLongDate, today } from '../../domain/dates.js';
import { formatMoney } from '../../domain/money.js';
import { isOverdue, isOutstanding } from '../../domain/invoice.js';
import type { Customer, Invoice, Organization } from '../../domain/types.js';

/**
 * The facts the agent is allowed to know when it answers one customer.
 *
 * This is the single place where the boundary between customers is drawn. The
 * context is built from one customer's invoices only, so there is no path by
 * which another customer's figures could reach a prompt, let alone an email -
 * the model is never given data it must then be trusted not to repeat.
 *
 * Only `sent` invoices with money outstanding are included. A draft has not
 * been sent, so the customer does not owe it and must not be told about it.
 */

export interface CustomerContext {
  customer: Customer;
  organization: Organization;
  outstanding: Invoice[];
  overdue: Invoice[];
  totalOutstandingMinor: number;
}

export function buildCustomerContext(
  organization: Organization,
  customer: Customer,
  invoices: Invoice[],
  asOf = today(),
): CustomerContext {
  const mine = invoices.filter((invoice) => invoice.customerId === customer.customerId);
  const outstanding = mine
    .filter(isOutstanding)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    customer,
    organization,
    outstanding,
    overdue: outstanding.filter((invoice) => isOverdue(invoice, asOf)),
    totalOutstandingMinor: outstanding.reduce((sum, i) => sum + i.balanceDueMinor, 0),
  };
}

/**
 * The context rendered for the prompt. Amounts and dates are pre-formatted so
 * the model never has to do arithmetic or convert a date: its job is to choose
 * the words, not the figures. Everything it is allowed to state appears here
 * verbatim, which is also what makes the draft checkable afterwards.
 */
export function renderContextForPrompt(context: CustomerContext): string {
  const { customer, organization, outstanding, totalOutstandingMinor } = context;
  const lines: string[] = [];

  lines.push(`TODAY: ${formatLongDate(today())}`);
  lines.push('');
  lines.push('ORGANIZATION (the sender, that is us):');
  lines.push(`  Name: ${organization.name}`);
  lines.push(`  Accounts contact: ${organization.accountsContactName} <${organization.accountsEmail}>`);
  lines.push(`  Address: ${organization.address}`);
  lines.push(`  Phone: ${organization.phone}`);
  lines.push(`  Payment terms: ${organization.paymentTerms}`);
  lines.push(`  Payment methods: ${organization.paymentMethods.join(', ')}`);
  lines.push('  Bank details:');
  lines.push(`    Account name: ${organization.bankDetails.accountName}`);
  lines.push(`    Account number: ${organization.bankDetails.accountNumber}`);
  lines.push(`    Bank: ${organization.bankDetails.bank}`);
  lines.push(`    IFSC: ${organization.bankDetails.ifsc}`);
  lines.push(`    SWIFT: ${organization.bankDetails.swiftCode}`);
  lines.push('  Policies:');
  for (const [key, value] of Object.entries(organization.policies)) {
    lines.push(`    ${key}: ${value}`);
  }

  lines.push('');
  lines.push('CUSTOMER (the person you are replying to):');
  lines.push(`  Company: ${customer.name}`);
  lines.push(`  Contact: ${customer.contactName} <${customer.contactEmail}>`);
  lines.push(`  Location: ${customer.city}, ${customer.country}`);
  lines.push(`  Billing currency: ${customer.currency}`);

  lines.push('');
  lines.push('THEIR OUTSTANDING INVOICES (these are the only invoices you may mention):');
  if (outstanding.length === 0) {
    lines.push('  None. This customer has nothing outstanding.');
  } else {
    for (const invoice of outstanding) {
      const overdueNote = isOverdue(invoice) ? ' [OVERDUE]' : '';
      lines.push(
        `  ${invoice.invoiceNumber}: ${formatMoney(invoice.balanceDueMinor, invoice.currency)} outstanding of ${formatMoney(invoice.totalMinor, invoice.currency)}, due ${formatLongDate(invoice.dueDate)}, invoiced ${formatLongDate(invoice.invoiceDate)}${overdueNote}`,
      );
      if (invoice.poNumber) lines.push(`      Purchase order: ${invoice.poNumber}`);
    }
    lines.push(
      `  TOTAL OUTSTANDING: ${formatMoney(totalOutstandingMinor, outstanding[0]!.currency)}`,
    );
  }

  return lines.join('\n');
}
