import { formatLongDate, today } from '../../domain/dates.js';
import { formatMoney } from '../../domain/money.js';
import { daysOverdue } from '../../domain/invoice.js';
import type { Customer, Invoice, Organization } from '../../domain/types.js';

/**
 * Reminder emails are built from a template, not written by the model.
 *
 * Every figure in a reminder comes straight out of the invoice record, so there
 * is no step at which an amount, a date or an invoice number could be invented.
 * The model is used for replying to customers, where the wording has to respond
 * to what they said; a reminder has nothing to interpret, so it does not need
 * one and must not depend on one being available.
 */

export interface RenderedEmail {
  subject: string;
  body: string;
}

function bankBlock(organization: Organization, currency: string): string {
  const { bankDetails, paymentMethods } = organization;
  const international = currency !== 'INR';
  const methods = international
    ? paymentMethods.filter((m) => m === 'SWIFT' || m === 'SEPA')
    : paymentMethods.filter((m) => m !== 'SWIFT' && m !== 'SEPA');

  const lines = [
    `You can pay by ${methods.join(', ')} to:`,
    `  Account name: ${bankDetails.accountName}`,
    `  Account number: ${bankDetails.accountNumber}`,
    `  Bank: ${bankDetails.bank}`,
  ];
  if (international) lines.push(`  SWIFT: ${bankDetails.swiftCode}`);
  else lines.push(`  IFSC: ${bankDetails.ifsc}`);
  return lines.join('\n');
}

export function renderReminder(
  organization: Organization,
  customer: Customer,
  invoices: Invoice[],
  asOf = today(),
): RenderedEmail {
  const sorted = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const first = sorted[0]!;
  const currency = first.currency;
  const total = sorted.reduce((sum, invoice) => sum + invoice.balanceDueMinor, 0);

  const subject =
    sorted.length === 1
      ? `Payment reminder: invoice ${first.invoiceNumber} from ${organization.name}`
      : `Payment reminder: ${sorted.length} overdue invoices from ${organization.name}`;

  const invoiceLines = sorted.map((invoice) => {
    const late = daysOverdue(invoice, asOf);
    const lateNote = late > 0 ? `, ${late} day${late === 1 ? '' : 's'} overdue` : '';
    return `  - ${invoice.invoiceNumber}: ${formatMoney(invoice.balanceDueMinor, invoice.currency)}, due ${formatLongDate(invoice.dueDate)}${lateNote}`;
  });

  const body = [
    `Dear ${customer.contactName},`,
    '',
    sorted.length === 1
      ? `Our records show that invoice ${first.invoiceNumber} is past its due date and still unpaid.`
      : `Our records show that the following invoices are past their due date and still unpaid.`,
    '',
    ...invoiceLines,
    '',
    sorted.length > 1
      ? `The total outstanding is ${formatMoney(total, currency)}.`
      : '',
    '',
    bankBlock(organization, currency),
    '',
    'If you have already paid, please reply with the payment date and reference and we will match it against your account.',
    'If anything on these invoices looks wrong, reply to this email and we will look into it.',
    '',
    'Kind regards,',
    organization.accountsContactName,
    organization.name,
    organization.phone,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');

  return { subject, body };
}

/**
 * The fallback reply used when no model is available, or when a draft fails
 * validation and a person needs something to edit rather than a blank box.
 */
export function renderFallbackAnswer(
  organization: Organization,
  customer: Customer,
  invoices: Invoice[],
): RenderedEmail {
  const total = invoices.reduce((sum, invoice) => sum + invoice.balanceDueMinor, 0);
  const currency = invoices[0]?.currency ?? customer.currency;

  const body = [
    `Dear ${customer.contactName},`,
    '',
    'Thank you for your email.',
    '',
    invoices.length === 0
      ? 'Our records show nothing outstanding on your account at the moment.'
      : `Our records show the following outstanding with us:`,
    ...invoices.map(
      (invoice) =>
        `  - ${invoice.invoiceNumber}: ${formatMoney(invoice.balanceDueMinor, invoice.currency)}, due ${formatLongDate(invoice.dueDate)}`,
    ),
    invoices.length > 1 ? `\nThe total outstanding is ${formatMoney(total, currency)}.` : '',
    '',
    bankBlock(organization, currency),
    '',
    'Kind regards,',
    organization.accountsContactName,
    organization.name,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');

  return { subject: `Re: your account with ${organization.name}`, body };
}
