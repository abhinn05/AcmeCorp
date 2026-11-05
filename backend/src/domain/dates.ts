import { env } from '../config/env.js';

/**
 * Dates in this application are calendar dates, not instants: an invoice is due
 * on a day, and a bank statement row happened on a day. They are stored and
 * compared as 'YYYY-MM-DD' strings, which sort lexicographically in the same
 * order they sort chronologically. "Today" is resolved in the organization's
 * timezone so that an invoice does not turn overdue at 05:30 IST because the
 * server happens to run in UTC.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function today(now: Date = new Date()): IsoDate {
  // en-CA renders as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toUtcMillis(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Positive when `a` is later than `b`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMillis(a) - toUtcMillis(b)) / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const next = new Date(toUtcMillis(date) + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

export function isBefore(a: IsoDate, b: IsoDate): boolean {
  return a < b;
}

/** "19 September 2026" - how the agent writes a date in an email. */
export function formatLongDate(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "30 Sep" - the compact form used in the reconciliation table. */
export function formatShortDate(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
