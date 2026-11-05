import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMinor, type Currency } from '../domain/money.js';
import type { Customer, Invoice, LineItem, Organization } from '../domain/types.js';

/**
 * Reading the supplied data files and converting them into the shape the
 * application stores. This is the single boundary where amounts in rupees and
 * dollars become integer minor units, and it is shared by the seed script and
 * by the tests so that both see exactly the same data.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** backend/src/services -> the repository's data folder. */
export const DATA_DIR = process.env['DATA_DIR']
  ? resolve(process.env['DATA_DIR'])
  : resolve(here, '../../../data');

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(resolve(DATA_DIR, filename), 'utf8')) as T;
}

interface RawOrganization {
  name: string;
  address: string;
  accounts_contact_name: string;
  accounts_email: string;
  phone: string;
  default_currency: string;
  accepted_currencies: string[];
  payment_terms: string;
  payment_methods: string[];
  bank_details: {
    account_name: string;
    account_number: string;
    bank: string;
    ifsc: string;
    swift_code: string;
  };
  policies: Record<string, string>;
}

interface RawCustomer {
  customer_id: string;
  name: string;
  contact_name: string;
  contact_email: string;
  phone: string;
  city: string;
  country: string;
  currency: string;
}

interface RawInvoice {
  invoice_number: string;
  customer_id: string;
  customer_name: string;
  po_number: string | null;
  invoice_date: string;
  due_date: string;
  payment_terms: string;
  currency: string;
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
  }>;
  subtotal: number;
  discount: number;
  tax_name: string;
  tax: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  status: 'draft' | 'sent' | 'paid';
}

export function loadOrganization(): Organization {
  const raw = readJson<RawOrganization>('organization.json');
  return {
    name: raw.name,
    address: raw.address,
    accountsContactName: raw.accounts_contact_name,
    accountsEmail: raw.accounts_email,
    phone: raw.phone,
    defaultCurrency: raw.default_currency as Currency,
    acceptedCurrencies: raw.accepted_currencies as Currency[],
    paymentTerms: raw.payment_terms,
    paymentMethods: raw.payment_methods,
    bankDetails: {
      accountName: raw.bank_details.account_name,
      accountNumber: raw.bank_details.account_number,
      bank: raw.bank_details.bank,
      ifsc: raw.bank_details.ifsc,
      swiftCode: raw.bank_details.swift_code,
    },
    policies: raw.policies,
  };
}

export function loadCustomers(): Customer[] {
  return readJson<RawCustomer[]>('customers.json').map((raw) => ({
    customerId: raw.customer_id,
    name: raw.name,
    contactName: raw.contact_name,
    contactEmail: raw.contact_email,
    phone: raw.phone,
    city: raw.city,
    country: raw.country,
    currency: raw.currency as Currency,
    updatedAt: new Date(),
  }));
}

export function loadInvoices(): Invoice[] {
  return readJson<RawInvoice[]>('invoices.json').map((raw) => {
    const lineItems: LineItem[] = raw.line_items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceMinor: toMinor(item.unit_price),
      amountMinor: toMinor(item.amount),
    }));
    return {
      invoiceNumber: raw.invoice_number,
      customerId: raw.customer_id,
      customerName: raw.customer_name,
      poNumber: raw.po_number,
      invoiceDate: raw.invoice_date,
      dueDate: raw.due_date,
      paymentTerms: raw.payment_terms,
      currency: raw.currency as Currency,
      lineItems,
      subtotalMinor: toMinor(raw.subtotal),
      discountMinor: toMinor(raw.discount),
      taxName: raw.tax_name,
      taxMinor: toMinor(raw.tax),
      totalMinor: toMinor(raw.total),
      amountPaidMinor: toMinor(raw.amount_paid),
      balanceDueMinor: toMinor(raw.balance_due),
      status: raw.status,
      lastReminderAt: null,
      reminderCount: 0,
      updatedAt: new Date(),
    };
  });
}

export function loadSampleStatementCsv(): string {
  return readFileSync(resolve(DATA_DIR, 'bank_statement_sample.csv'), 'utf8');
}
