import { formatLongDate } from '../../domain/dates.js';
import { formatMoney, toMinor } from '../../domain/money.js';
import type { Customer, Invoice } from '../../domain/types.js';
import type { CustomerContext } from './context.js';

/**
 * Checking a drafted reply before it is allowed to leave the building.
 *
 * The assignment asks that every amount, date and invoice number in an email
 * matches the database. Asking the model nicely is not a control, so the draft
 * is parsed and each figure in it is looked up: anything that does not appear
 * in this customer's own records is a failure, and a failed draft is never
 * sent, only offered to a person to edit.
 *
 * The same pass enforces the promises the agent is not allowed to make and the
 * confidentiality rule that one customer may not be told about another.
 */

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

/** Every money figure in the text, as minor units, whatever the formatting. */
export function extractAmounts(text: string): number[] {
  const amounts: number[] = [];
  // Matches 1,18,000.00 / 1,180,000 / 12500.50, with or without a symbol.
  for (const match of text.matchAll(/(?:[₹$€£]\s?)?(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
    const raw = match[1]!;
    // Bare one- and two-digit numbers are counts and dates, not amounts.
    if (!raw.includes(',') && !raw.includes('.') && raw.length <= 3) continue;
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) amounts.push(toMinor(value));
  }
  return amounts;
}

export function extractInvoiceNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bINV[\s\-#]?0*(\d{3,6})\b/gi)) found.add(`INV-${match[1]}`);
  return [...found];
}

/** Long-form dates as the agent writes them, plus the ISO form. */
export function extractDates(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})\b/g)) found.add(match[1]!);
  for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) found.add(match[1]!);
  return [...found];
}

/** Phrases that would commit the organization to something only a person may. */
const FORBIDDEN_COMMITMENTS: Array<{ pattern: RegExp; issue: string }> = [
  { pattern: /\b(?:marked|mark|marking) (?:it |this |the invoice )?as paid\b/i, issue: 'claims an invoice has been marked as paid' },
  { pattern: /\b(?:invoice|account|balance) (?:is|has been) (?:now )?(?:fully )?(?:paid|settled|cleared|closed)\b/i, issue: 'confirms a payment that the bank has not confirmed' },
  { pattern: /\bpayment (?:has been |is )?(?:received|confirmed|credited)\b/i, issue: 'confirms a payment that the bank has not confirmed' },
  { pattern: /\b(?:we|i) (?:can |will |would be happy to )?(?:agree|grant|approve|allow|extend|offer)\b[^.]{0,60}\b(?:extension|more time|instal?ment|additional time|until|till)\b/i, issue: 'agrees to a later payment date' },
  { pattern: /\b(?:waive|waived|waiver|write(?:n)? off|discount of|reduce the amount|credit note will)\b/i, issue: 'offers a waiver, discount or write-off' },
  { pattern: /\bno (?:further )?action (?:is )?(?:required|needed)\b/i, issue: 'tells the customer nothing further is owed' },
  { pattern: /\b(?:we accept|we acknowledge that|you are right that) (?:the|your) dispute\b/i, issue: 'accepts a dispute' },
];

export interface ValidateOptions {
  /** Every customer, so a mention of another one can be detected. */
  allCustomers: Customer[];
}

export function validateDraft(
  draft: string,
  context: CustomerContext,
  options: ValidateOptions,
): ValidationResult {
  const issues: string[] = [];
  if (draft.trim().length === 0) return { ok: false, issues: ['the draft is empty'] };
  if (draft.length > 8000) issues.push('the draft is implausibly long');

  const { customer, organization, outstanding } = context;

  // --- Invoice numbers -----------------------------------------------------
  const allowedInvoices = new Set(outstanding.map((i) => i.invoiceNumber));
  for (const mentioned of extractInvoiceNumbers(draft)) {
    if (!allowedInvoices.has(mentioned)) {
      issues.push(
        `mentions ${mentioned}, which is not an outstanding invoice for ${customer.name}`,
      );
    }
  }

  // --- Amounts -------------------------------------------------------------
  const allowedAmounts = new Set<number>();
  for (const invoice of outstanding) {
    allowedAmounts.add(invoice.balanceDueMinor);
    allowedAmounts.add(invoice.totalMinor);
    allowedAmounts.add(invoice.subtotalMinor);
    allowedAmounts.add(invoice.taxMinor);
    allowedAmounts.add(invoice.amountPaidMinor);
  }
  allowedAmounts.add(outstanding.reduce((sum, i) => sum + i.balanceDueMinor, 0));
  // The bank account number is a long digit string, not an amount, but it is
  // written in an email, so it is allowed through explicitly.
  const bankNumbers = new Set(
    [organization.bankDetails.accountNumber, organization.phone.replace(/\D/g, '')].map((v) =>
      v.replace(/\D/g, ''),
    ),
  );

  for (const amount of extractAmounts(draft)) {
    if (allowedAmounts.has(amount)) continue;
    if (bankNumbers.has(String(amount / 100).replace(/\D/g, ''))) continue;
    if (bankNumbers.has(String(amount).replace(/\D/g, ''))) continue;
    issues.push(
      `states ${formatMoney(amount, customer.currency)}, which does not match any figure on this customer's invoices`,
    );
  }

  // --- Dates ---------------------------------------------------------------
  const allowedDates = new Set<string>();
  for (const invoice of outstanding) {
    allowedDates.add(invoice.dueDate);
    allowedDates.add(invoice.invoiceDate);
    allowedDates.add(formatLongDate(invoice.dueDate));
    allowedDates.add(formatLongDate(invoice.invoiceDate));
  }
  for (const mentioned of extractDates(draft)) {
    // A date the customer themselves proposed is quoted back legitimately, so
    // only dates presented as ours are checked.
    if (!allowedDates.has(mentioned) && isPresentedAsOurDate(draft, mentioned)) {
      issues.push(`states the date ${mentioned}, which is not on any of this customer's invoices`);
    }
  }

  // --- Promises ------------------------------------------------------------
  for (const { pattern, issue } of FORBIDDEN_COMMITMENTS) {
    if (pattern.test(draft)) issues.push(issue);
  }

  // --- Confidentiality -----------------------------------------------------
  for (const other of options.allCustomers) {
    if (other.customerId === customer.customerId) continue;
    const distinctive = other.name.split(/\s+/)[0]!;
    if (distinctive.length >= 4 && new RegExp(`\\b${escapeRegExp(distinctive)}\\b`, 'i').test(draft)) {
      issues.push(`mentions another customer, ${other.name}`);
    }
    if (other.contactEmail && draft.toLowerCase().includes(other.contactEmail.toLowerCase())) {
      issues.push(`contains another customer's email address`);
    }
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

/**
 * A date is "ours" when it is introduced as a due date or a date we are
 * asserting, rather than quoted from the customer's own message.
 */
function isPresentedAsOurDate(draft: string, date: string): boolean {
  const index = draft.indexOf(date);
  if (index === -1) return false;
  const before = draft.slice(Math.max(0, index - 40), index).toLowerCase();
  return /\b(due|dated|payable|by|on or before|invoice date)\b[^.]*$/.test(before);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A short, human explanation of why a reply was held back. */
export function describeIssues(issues: string[]): string {
  if (issues.length === 0) return '';
  return `The drafted reply was held back because it ${issues.join('; and it ')}.`;
}

export type { Invoice };
