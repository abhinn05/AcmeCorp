/**
 * Turning a bank narration into something comparable with a company name.
 *
 * Narrations are short, upper-case and inconsistent. They carry a transfer
 * method, a direction marker, sometimes an invoice number, sometimes a
 * truncated payer name, and often a few words of noise. Everything in this file
 * is about stripping the parts that carry no evidence so the similarity
 * measures only ever see the parts that do.
 */

/** NEFT, RTGS, IMPS and UPI are Indian rails; SWIFT and SEPA are international. */
export const TRANSFER_METHODS = [
  'NEFT',
  'RTGS',
  'IMPS',
  'UPI',
  'SWIFT',
  'SEPA',
  'ACH',
  'WIRE',
  'TRF',
  'TRANSFER',
  'CHQ',
  'CHEQUE',
] as const;

/** Direction markers and other bank bookkeeping tokens. */
const DIRECTION_TOKENS = new Set(['CR', 'DR', 'CRDT', 'DEBIT', 'CREDIT', 'BY', 'TO', 'FROM']);

/**
 * Company suffixes. They are removed before comparison because almost every
 * Indian customer here ends in "PVT LTD": leaving them in makes every pair of
 * names look alike, which is exactly the false-positive we cannot afford.
 */
const LEGAL_SUFFIXES = new Set([
  'PVT',
  'PRIVATE',
  'LTD',
  'LIMITED',
  'LLP',
  'LLC',
  'INC',
  'INCORPORATED',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'GMBH',
  'MBH',
  'AG',
  'BV',
  'NV',
  'SA',
  'SAS',
  'SRL',
  'PLC',
  'OY',
  'AB',
  'AS',
]);

/** Words a bank or a payer adds that say nothing about who paid. */
const NOISE_TOKENS = new Set([
  'PART',
  'PARTIAL',
  'PAYMENT',
  'PAYMENTS',
  'PAY',
  'PMT',
  'PYMT',
  'DUES',
  'DUE',
  'AGAINST',
  'TOWARDS',
  'TOWARD',
  'SETTLEMENT',
  'SETTLE',
  'ADVANCE',
  'BILL',
  'BILLS',
  'AMT',
  'AMOUNT',
  'RECEIPT',
  'RCPT',
  'REF',
  'REFERENCE',
  'NO',
  'NUM',
  'FUND',
  'FUNDS',
  'ONLINE',
  'NETBANKING',
  'COLLECTION',
  'COLLECTIONS',
  'ACCOUNT',
  'AC',
  'A',
  'THE',
  'AND',
  'OF',
  'FOR',
]);

const MONTH_TOKENS = new Set([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'SEPT',
  'OCT',
  'NOV',
  'DEC',
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'FY',
]);

/**
 * Narrations that are the bank talking to itself rather than a customer paying.
 * Credit interest is money in, but it is not a receipt against any invoice, so
 * it must be set aside rather than scored as "no match found".
 */
const BANK_GENERATED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bINT(?:\.|\s)?(?:PD|CR|PAID|EARNED)\b/i, reason: 'Bank interest credited, not a customer receipt' },
  { pattern: /\bINTEREST\s+(?:PAID|CREDIT)/i, reason: 'Bank interest credited, not a customer receipt' },
  { pattern: /\bCREDIT\s+INTEREST\b/i, reason: 'Bank interest credited, not a customer receipt' },
  { pattern: /\b(?:BANK\s+)?CHARGES?\b/i, reason: 'Bank charge, not a customer receipt' },
  { pattern: /\bSERVICE\s+CHARGE/i, reason: 'Bank charge, not a customer receipt' },
  { pattern: /\bGST\s+ON\s+/i, reason: 'Bank-levied tax, not a customer receipt' },
  { pattern: /\bREVERSAL\b/i, reason: 'Reversal entry, not a customer receipt' },
  { pattern: /\bOPENING\s+BALANCE\b/i, reason: 'Statement balance line, not a customer receipt' },
];

export function detectBankGenerated(narration: string): string | null {
  for (const { pattern, reason } of BANK_GENERATED_PATTERNS) {
    if (pattern.test(narration)) return reason;
  }
  return null;
}

/** Upper-cases and reduces every separator to a single space. */
export function basicNormalize(value: string): string {
  return value
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface NormalizeOptions {
  /** Drop long digit runs such as bank references, which are never payer names. */
  dropLongNumbers?: boolean;
}

/**
 * The comparison form of a string: upper case, no punctuation, no transfer
 * method, no direction marker, no legal suffix, no filler words.
 */
export function normalizeForComparison(value: string, options: NormalizeOptions = {}): string {
  const { dropLongNumbers = true } = options;
  const tokens = basicNormalize(value).split(' ').filter(Boolean);
  const kept: string[] = [];

  for (const token of tokens) {
    if ((TRANSFER_METHODS as readonly string[]).includes(token)) continue;
    if (DIRECTION_TOKENS.has(token)) continue;
    if (LEGAL_SUFFIXES.has(token)) continue;
    if (NOISE_TOKENS.has(token)) continue;
    if (MONTH_TOKENS.has(token)) continue;
    if (dropLongNumbers && /^\d{4,}$/.test(token)) continue;
    if (/^\d{1,3}$/.test(token)) continue;
    kept.push(token);
  }
  return kept.join(' ');
}

/**
 * Candidate payer strings pulled out of a narration.
 *
 * Banks delimit with slashes and hyphens, so "IMPS/KESTREL FOODS/INV 1004"
 * really is three fields. Each segment is offered as a candidate alongside the
 * whole narration, and the matcher keeps whichever scores best. That way a
 * payer name sitting next to noise is still found, without having to guess
 * which delimiter a particular bank used.
 */
export function payerCandidates(narration: string): string[] {
  const candidates = new Set<string>();

  const whole = normalizeForComparison(narration);
  if (whole) candidates.add(whole);

  for (const segment of narration.split(/[\/|,;:]+/)) {
    const normalized = normalizeForComparison(segment);
    if (normalized.length >= 3) candidates.add(normalized);
  }

  // Hyphens separate fields too, but a hyphen also appears inside "INV-1002",
  // so split on hyphens only after invoice numbers have been masked out.
  const withoutInvoiceNumbers = narration.replace(INVOICE_NUMBER_PATTERN, ' ');
  for (const segment of withoutInvoiceNumbers.split(/[-–—]+/)) {
    const normalized = normalizeForComparison(segment);
    if (normalized.length >= 3) candidates.add(normalized);
  }

  return [...candidates].filter(Boolean);
}

/**
 * Invoice-number-shaped tokens.
 *
 * Covers "INV-1002", "INV 1004", "INV1021" and the German "RE 1024" that a SEPA
 * payer writes for "Rechnung". The number alone is returned; whether it refers
 * to a real invoice is decided by the caller against the database, which is the
 * only guard that stops a reference number being read as an invoice number.
 */
export const INVOICE_NUMBER_PATTERN =
  /\b(?:INV|INVOICE|INVNO|BILL|RE|RECH|RECHNUNG|FACT|FACTURE)[\s\-#:.]*0*(\d{3,6})\b/gi;

export interface ExtractedInvoiceRef {
  digits: string;
  /** True when an explicit keyword such as INV preceded the number. */
  keyworded: boolean;
}

export function extractInvoiceRefs(narration: string): ExtractedInvoiceRef[] {
  const refs: ExtractedInvoiceRef[] = [];
  const seen = new Set<string>();

  for (const match of narration.matchAll(INVOICE_NUMBER_PATTERN)) {
    const digits = match[1]!;
    if (!seen.has(digits)) {
      seen.add(digits);
      refs.push({ digits, keyworded: true });
    }
  }

  // A bare four-digit group is a much weaker signal, but some banks drop the
  // keyword entirely. It is only ever used if it resolves to a real invoice.
  const masked = narration.replace(INVOICE_NUMBER_PATTERN, ' ');
  for (const match of masked.matchAll(/\b(\d{4})\b/g)) {
    const digits = match[1]!;
    if (!seen.has(digits)) {
      seen.add(digits);
      refs.push({ digits, keyworded: false });
    }
  }
  return refs;
}

/** Strips "INV-" style prefixes from a stored invoice number for comparison. */
export function invoiceNumberDigits(invoiceNumber: string): string {
  const match = invoiceNumber.match(/(\d{3,8})\s*$/);
  return match ? match[1]! : invoiceNumber.replace(/\D/g, '');
}

/**
 * Tokens of a name that actually identify it: no legal suffix, no filler. Used
 * to check that at least one distinctive word is shared before a payer match is
 * believed, which is what keeps "Maple Retail Services" from being matched to
 * "Nordlys Retail GmbH" on the strength of the word "Retail" alone.
 */
export function distinctiveTokens(value: string): string[] {
  return normalizeForComparison(value)
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERIC_BUSINESS_WORDS.has(t));
}

/**
 * Words that appear across many company names and so identify nobody. A match
 * resting only on these is treated as no match at all.
 */
export const GENERIC_BUSINESS_WORDS = new Set([
  'RETAIL',
  'SERVICES',
  'SERVICE',
  'SOLUTIONS',
  'SOLUTION',
  'TECH',
  'TECHNOLOGIES',
  'TECHNOLOGY',
  'SYSTEMS',
  'SYSTEM',
  'GROUP',
  'HOLDINGS',
  'INDUSTRIES',
  'ENTERPRISES',
  'ENTERPRISE',
  'TRADING',
  'TRADERS',
  'GLOBAL',
  'INTERNATIONAL',
  'INDIA',
  'VENTURES',
  'ASSOCIATES',
  'PARTNERS',
  'CONSULTING',
  'CONSULTANTS',
  'MEDIA',
  'LOGISTICS',
  'PACKAGING',
  'ANALYTICS',
  'FOODS',
  'CLINIC',
  'CLINICS',
  'HOSPITALITY',
]);
