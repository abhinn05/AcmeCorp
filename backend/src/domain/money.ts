/**
 * Money is held everywhere in this application as an integer number of minor
 * units (paise, cents, pence). Invoice totals like 194700.00 and the sums that
 * come out of matching several invoices against one payment cannot be compared
 * reliably as IEEE-754 doubles: 82600 + 41300 + 70800 must equal 194700 exactly
 * or reconciliation silently misses a match. The JSON data files and the bank
 * statement use major units, so they are converted once at the boundary.
 */

export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP';

export const SUPPORTED_CURRENCIES: readonly Currency[] = ['INR', 'USD', 'EUR', 'GBP'];

/** All four supported currencies happen to use two decimal places. */
const MINOR_UNITS_PER_MAJOR = 100;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** 59000.0 -> 5900000. Rounds half away from zero to avoid 0.1+0.2 style drift. */
export function toMinor(major: number): number {
  if (!Number.isFinite(major)) throw new RangeError(`Not a finite amount: ${major}`);
  const scaled = major * MINOR_UNITS_PER_MAJOR;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** 5900000 -> 59000. Only for display and for writing back out to JSON. */
export function toMajor(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/** Parses an amount from a CSV cell. Tolerates thousands separators and blanks. */
export function parseAmountToMinor(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/[\s,_]/g, '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return toMinor(value);
}

const LOCALE_BY_CURRENCY: Record<Currency, string> = {
  INR: 'en-IN',
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
};

/**
 * Formats for humans and for the body of an email. INR deliberately uses the
 * Indian grouping, so the agent writes "1,18,000.00" the way an Indian
 * accounts team would.
 */
export function formatMoney(minor: number, currency: Currency): string {
  return new Intl.NumberFormat(LOCALE_BY_CURRENCY[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
}

/**
 * Tax Deducted at Source. Indian customers may withhold 10% of the invoice
 * subtotal and pay it to the government instead, so a 354000 invoice with a
 * 300000 subtotal is fully settled by a 324000 receipt.
 */
export const TDS_RATE_BASIS_POINTS = 1000; // 10.00%

export function tdsAmountMinor(subtotalMinor: number): number {
  return Math.round((subtotalMinor * TDS_RATE_BASIS_POINTS) / 10000);
}
