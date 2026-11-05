import { daysBetween, today, type IsoDate } from './dates.js';
import type { Invoice, InvoiceView } from './types.js';

/**
 * "Overdue" is not a stored status. An invoice is overdue when it has been sent
 * to the customer, still has money outstanding, and its due date has passed.
 * A draft is never chased, because the customer does not owe it yet.
 */
export function isOverdue(invoice: Invoice, asOf: IsoDate = today()): boolean {
  return invoice.status === 'sent' && invoice.balanceDueMinor > 0 && invoice.dueDate < asOf;
}

export function daysOverdue(invoice: Invoice, asOf: IsoDate = today()): number {
  if (!isOverdue(invoice, asOf)) return 0;
  return daysBetween(asOf, invoice.dueDate);
}

export function toInvoiceView(invoice: Invoice, asOf: IsoDate = today()): InvoiceView {
  return { ...invoice, isOverdue: isOverdue(invoice, asOf), daysOverdue: daysOverdue(invoice, asOf) };
}

/** What the customer actually owes right now: sent, with a balance remaining. */
export function isOutstanding(invoice: Invoice): boolean {
  return invoice.status === 'sent' && invoice.balanceDueMinor > 0;
}

/**
 * Applying a receipt. The status is derived from the resulting balance, so an
 * invoice can only become paid by the money adding up, or by a person
 * explicitly closing the remainder as TDS withheld.
 */
export function applyPayment(
  invoice: Invoice,
  amountMinor: number,
  closeRemainderAsTds: boolean,
): { amountPaidMinor: number; balanceDueMinor: number; status: Invoice['status']; tdsWriteOffMinor: number } {
  const amountPaidMinor = invoice.amountPaidMinor + amountMinor;
  let balanceDueMinor = invoice.totalMinor - amountPaidMinor;
  let tdsWriteOffMinor = 0;

  if (balanceDueMinor > 0 && closeRemainderAsTds) {
    tdsWriteOffMinor = balanceDueMinor;
    balanceDueMinor = 0;
  }
  // An overpayment leaves the invoice at zero rather than going negative; the
  // surplus is visible as amount paid exceeding the total.
  if (balanceDueMinor < 0) balanceDueMinor = 0;

  const status: Invoice['status'] = balanceDueMinor === 0 ? 'paid' : invoice.status;
  return { amountPaidMinor, balanceDueMinor, status, tdsWriteOffMinor };
}
