import { parse } from 'csv-parse/sync';
import { isIsoDate, type IsoDate } from '../domain/dates.js';
import { isCurrency, parseAmountToMinor } from '../domain/money.js';
import type { StatementRowInput } from '../domain/types.js';

/**
 * Reading an uploaded bank statement.
 *
 * The file arrives from a browser, so it is treated as untrusted input: the
 * header is checked against the expected columns, every field is validated, and
 * the number of rows is capped. A malformed row is reported with its line
 * number instead of being silently dropped, because a receipt that quietly
 * disappears is worse than an upload that fails.
 */

export const REQUIRED_COLUMNS = [
  'txn_date',
  'narration',
  'reference',
  'credit',
  'debit',
  'currency',
] as const;

const MAX_ROWS = 5000;

export interface ParsedStatement {
  rows: StatementRowInput[];
  errors: Array<{ line: number; message: string }>;
}

export class StatementParseError extends Error {
  readonly status = 400;
}

export function parseStatementCsv(content: string): ParsedStatement {
  const text = content.replace(/^﻿/, '').trim();
  if (text.length === 0) throw new StatementParseError('The uploaded file is empty.');

  let records: Array<Record<string, string>>;
  try {
    records = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    }) as Array<Record<string, string>>;
  } catch (error) {
    throw new StatementParseError(
      `The file could not be read as CSV: ${(error as Error).message}`,
    );
  }

  if (records.length === 0) throw new StatementParseError('The file has a header but no rows.');
  if (records.length > MAX_ROWS) {
    throw new StatementParseError(`The file has more than ${MAX_ROWS} rows.`);
  }

  const header = Object.keys(records[0]!);
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new StatementParseError(
      `Missing column(s): ${missing.join(', ')}. Expected ${REQUIRED_COLUMNS.join(', ')}.`,
    );
  }

  const rows: StatementRowInput[] = [];
  const errors: Array<{ line: number; message: string }> = [];

  records.forEach((record, index) => {
    const line = index + 2; // +1 for the header, +1 because humans count from one
    const txnDate = (record['txn_date'] ?? '').trim();
    const currency = (record['currency'] ?? '').trim().toUpperCase();
    const narration = (record['narration'] ?? '').trim();

    if (!isIsoDate(txnDate)) {
      errors.push({ line, message: `txn_date "${txnDate}" is not a YYYY-MM-DD date` });
      return;
    }
    if (!isCurrency(currency)) {
      errors.push({ line, message: `currency "${currency}" is not one of INR, USD, EUR, GBP` });
      return;
    }
    if (narration.length > 500) {
      errors.push({ line, message: 'narration is unreasonably long' });
      return;
    }

    const creditMinor = parseAmountToMinor(record['credit']);
    const debitMinor = parseAmountToMinor(record['debit']);
    if (creditMinor === null && debitMinor === null) {
      errors.push({ line, message: 'row has neither a credit nor a debit amount' });
      return;
    }

    const reference = (record['reference'] ?? '').trim();
    rows.push({
      txnDate: txnDate as IsoDate,
      narration,
      reference: reference === '' ? null : reference.slice(0, 120),
      creditMinor,
      debitMinor,
      currency,
    });
  });

  if (rows.length === 0) {
    throw new StatementParseError(
      `No usable rows. First problem: ${errors[0]?.message ?? 'unknown'}`,
    );
  }
  return { rows, errors };
}
