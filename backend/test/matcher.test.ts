import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReconciliationMatcher } from '../src/services/matching/matcher.js';
import { parseStatementCsv } from '../src/services/statementParser.js';
import { loadCustomers, loadInvoices, loadSampleStatementCsv } from '../src/services/seedData.js';
import { toMinor } from '../src/domain/money.js';
import {
  abbreviationCoverage,
  jaroWinkler,
  levenshteinRatio,
  tokenSetRatio,
} from '../src/services/matching/similarity.js';
import { extractInvoiceRefs, payerCandidates } from '../src/services/matching/normalize.js';

const customers = loadCustomers();
const invoices = loadInvoices();
const matcher = new ReconciliationMatcher({ customers, invoices });
const { rows } = parseStatementCsv(loadSampleStatementCsv());

function matchNarration(narration: string) {
  const row = rows.find((r) => r.narration === narration);
  assert.ok(row, `No sample row with narration "${narration}"`);
  return matcher.match(row);
}

function singleInvoice(narration: string): { invoiceNumber: string; score: number } {
  const result = matchNarration(narration);
  assert.ok(result.best, `Expected a suggestion for "${narration}"`);
  assert.equal(result.best.allocations.length, 1, 'expected exactly one invoice');
  return {
    invoiceNumber: result.best.allocations[0]!.invoiceNumber,
    score: result.best.score,
  };
}

describe('similarity measures', () => {
  it('rewards a shared prefix when a name is truncated', () => {
    // The whole reason Jaro-Winkler is in the blend: edit distance punishes the
    // missing tail of an abbreviated name, the prefix bonus compensates.
    assert.ok(jaroWinkler('ORBIS PKG', 'ORBIS PACKAGING') > levenshteinRatio('ORBIS PKG', 'ORBIS PACKAGING'));
    assert.equal(abbreviationCoverage('ORBIS PKG', 'ORBIS PACKAGING'), 1);
  });

  it('ignores extra tokens around a name', () => {
    assert.ok(tokenSetRatio('SAFFRON PEAK HOSP OCT DUES', 'SAFFRON PEAK HOSP') > 0.9);
  });
});

describe('narration parsing', () => {
  it('pulls the payer out of a slash-delimited narration', () => {
    assert.ok(payerCandidates('IMPS/KESTREL FOODS/INV 1004').includes('KESTREL FOODS'));
  });

  it('reads invoice numbers written in several styles', () => {
    assert.deepEqual(extractInvoiceRefs('INV 1004').map((r) => r.digits), ['1004']);
    assert.deepEqual(extractInvoiceRefs('INV-1002').map((r) => r.digits), ['1002']);
    assert.deepEqual(extractInvoiceRefs('INV1021').map((r) => r.digits), ['1021']);
    // "RE" is how a German payer writes "Rechnung" on a SEPA transfer.
    assert.deepEqual(extractInvoiceRefs('RE 1024').map((r) => r.digits), ['1024']);
  });
});

describe('matching the sample statement', () => {
  it('matches on an invoice number quoted in the narration', () => {
    const result = singleInvoice('IMPS/KESTREL FOODS/INV 1004');
    assert.equal(result.invoiceNumber, 'INV-1004');
    assert.ok(result.score >= 90, `expected a confident score, got ${result.score}`);
  });

  it('matches an international receipt across currencies', () => {
    assert.equal(singleInvoice('SWIFT CR HARBOUR ANALYTICS INC INV1021').invoiceNumber, 'INV-1021');
    assert.equal(singleInvoice('SEPA CR NORDLYS RETAIL GMBH RE 1024').invoiceNumber, 'INV-1024');
    assert.equal(singleInvoice('SWIFT CR THORNFIELD MEDIA LTD').invoiceNumber, 'INV-1026');
  });

  it('matches a hyphen-delimited narration with the payer and the invoice number', () => {
    const result = singleInvoice('NEFT CR-BRIGHTLINE LOGISTICS PVT LTD-INV-1002');
    assert.equal(result.invoiceNumber, 'INV-1002');
    assert.ok(result.score >= 90);
  });

  it('recognises a payment short by exactly the TDS withheld', () => {
    const result = matchNarration('RTGS CR-QUILLON TECH PVT LTD');
    assert.ok(result.best);
    assert.equal(result.best.allocations[0]!.invoiceNumber, 'INV-1007');
    assert.equal(result.best.tdsConsistent, true);
    // 10% of the 300000 subtotal was withheld, so 30000 is outstanding.
    assert.equal(result.best.shortfallMinor, toMinor(30000));
  });

  it('matches an abbreviated payer and reports it as a part payment', () => {
    const result = matchNarration('UPI/ORBIS PKG/PART PAYMENT');
    assert.ok(result.best);
    assert.equal(result.best.allocations[0]!.invoiceNumber, 'INV-1013');
    assert.equal(result.best.shortfallMinor, toMinor(472000 - 200000));
  });

  it('splits one receipt across several invoices when they add up', () => {
    const result = matchNarration('NEFT CR-SAFFRON PEAK HOSP-OCT DUES');
    assert.ok(result.best);
    const numbers = result.best.allocations.map((a) => a.invoiceNumber).sort();
    assert.deepEqual(numbers, ['INV-1010', 'INV-1011', 'INV-1012']);
    const total = result.best.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    assert.equal(total, toMinor(194700));
  });

  it('matches a payer named only by their trading name', () => {
    assert.equal(singleInvoice('NEFT CR-REDWOOD CLINIC').invoiceNumber, 'INV-1016');
  });

  it('still suggests when only the amount identifies the invoice', () => {
    // "R K SHARMA" is not a customer name, but the amount settles exactly one
    // open invoice, so it is worth a low-confidence suggestion for review.
    const result = matchNarration('IMPS/R K SHARMA/CLINIC DUES');
    assert.ok(result.best);
    assert.equal(result.best.allocations[0]!.invoiceNumber, 'INV-1017');
    assert.ok(result.best.score < 70, 'an amount-only match must not look confident');
  });

  it('says no match rather than guessing at an unknown payer', () => {
    const result = matchNarration('NEFT CR-MAPLE RETAIL SERVICES');
    assert.equal(result.best, null);
    assert.match(result.noMatchReason ?? '', /not recognized|no invoice number/i);
  });

  it('never matches a payment to an invoice raised after it arrived', () => {
    const result = matchNarration('UPI/ORBIS PKG/PART PAYMENT');
    assert.ok(result.best);
    // INV-1014 is dated 2026-11-01, well after this 2026-09-10 receipt.
    const all = [result.best, ...result.alternatives].flatMap((s) => s.allocations);
    assert.ok(!all.some((a) => a.invoiceNumber === 'INV-1014'));
  });

  it('sets aside debits and bank-generated entries', () => {
    const debit = rows.find((r) => r.narration === 'NEFT DR-OFFICE RENT OCT')!;
    assert.equal(ReconciliationMatcher.classifyRow(debit).isReceipt, false);

    const interest = rows.find((r) => r.narration.startsWith('INT.PD'))!;
    const classified = ReconciliationMatcher.classifyRow(interest);
    assert.equal(classified.isReceipt, false);
    assert.match(classified.reason ?? '', /interest/i);
  });

  it('never suggests a draft or an already paid invoice', () => {
    for (const row of rows) {
      if (!ReconciliationMatcher.classifyRow(row).isReceipt) continue;
      const result = matcher.match(row);
      for (const suggestion of [result.best, ...result.alternatives]) {
        for (const allocation of suggestion?.allocations ?? []) {
          const invoice = invoices.find((i) => i.invoiceNumber === allocation.invoiceNumber)!;
          assert.equal(invoice.status, 'sent', `${invoice.invoiceNumber} is ${invoice.status}`);
          assert.ok(invoice.balanceDueMinor > 0);
        }
      }
    }
  });
});
