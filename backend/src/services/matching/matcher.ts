import { daysBetween, type IsoDate } from '../../domain/dates.js';
import { tdsAmountMinor, formatMoney, type Currency } from '../../domain/money.js';
import type {
  Customer,
  Invoice,
  MatchSuggestion,
  StatementRowInput,
  SuggestedAllocation,
} from '../../domain/types.js';
import {
  abbreviationCoverage,
  isContractionOf,
  jaroWinkler,
  NgramTfIdf,
  tokenJaccard,
  tokenSetRatio,
} from './similarity.js';
import {
  detectBankGenerated,
  distinctiveTokens,
  extractInvoiceRefs,
  invoiceNumberDigits,
  normalizeForComparison,
  payerCandidates,
} from './normalize.js';

/**
 * The reconciliation matcher.
 *
 * It is deliberately a local, deterministic algorithm: no model decides which
 * invoice a payment belongs to. Each candidate invoice accumulates evidence
 * from four independent directions - an invoice number in the narration, the
 * payer name, the amount, and whether the date makes sense - and the total is
 * the confidence shown to the person reviewing it. Evidence that contradicts a
 * candidate (wrong currency, money arriving before the invoice existed) removes
 * it outright rather than merely lowering its score.
 */

// --- Evidence weights -------------------------------------------------------
// These add to a little over 100 on a perfect match and are clamped, so a
// confident row scores in the high nineties without any single signal being
// able to carry a match on its own.
const W = {
  invoiceRefKeyworded: 42,
  invoiceRefBare: 20,
  payer: 30,
  amountExactBalance: 30,
  amountExactTotal: 28,
  amountTdsAdjusted: 27,
  amountCombination: 29,
  amountPartial: 7,
  amountUniqueInBook: 12,
  dateBeforeDue: 8,
  datePlausibleAfterDue: 6,
  dateStale: -8,
  onlyOpenInvoice: 5,
} as const;

/** Below this the matcher says "no match" rather than guess. */
export const SUGGESTION_THRESHOLD = 30;
/** Above this a suggestion is considered safe enough to present as confident. */
export const CONFIDENT_THRESHOLD = 70;
/** Payer similarity below this is not treated as naming the customer at all. */
const PAYER_THRESHOLD = 0.62;
/** Largest set of invoices considered for one payment. */
const MAX_COMBINATION_SIZE = 4;
/** A payment this long after the due date starts to look like a different one. */
const STALE_AFTER_DAYS = 150;
/** Tolerance on amount comparisons: one minor unit of rounding either way. */
const AMOUNT_TOLERANCE_MINOR = 2;

export interface MatchContext {
  customers: Customer[];
  /** Every invoice, so that a narration naming a paid invoice can be explained. */
  invoices: Invoice[];
}

interface PayerMatch {
  customerId: string;
  customerName: string;
  score: number;
  matchedOn: string;
}

interface Candidate {
  allocations: SuggestedAllocation[];
  invoices: Invoice[];
  customerId: string;
  score: number;
  evidence: string[];
  reason: string;
  tdsConsistent: boolean;
  shortfallMinor: number;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_TOLERANCE_MINOR;
}

function isOutstanding(invoice: Invoice): boolean {
  return invoice.status === 'sent' && invoice.balanceDueMinor > 0;
}

/**
 * The matcher is constructed once per statement so the TF-IDF model is fitted
 * on the customer book a single time rather than per row.
 */
export class ReconciliationMatcher {
  private readonly customers: Customer[];
  private readonly invoices: Invoice[];
  private readonly tfidf: NgramTfIdf;
  private readonly customerById = new Map<string, Customer>();
  private readonly normalizedNames = new Map<string, string[]>();

  constructor(context: MatchContext) {
    this.customers = context.customers;
    this.invoices = context.invoices;

    for (const customer of this.customers) {
      this.customerById.set(customer.customerId, customer);
      // The contact person is included because banks sometimes name the person
      // who initiated the transfer rather than the company.
      this.normalizedNames.set(customer.customerId, [
        normalizeForComparison(customer.name),
        normalizeForComparison(customer.contactName),
      ].filter(Boolean));
    }

    this.tfidf = new NgramTfIdf(
      this.customers.map((c) => normalizeForComparison(c.name)).filter(Boolean),
      3,
    );
  }

  /**
   * Blended payer similarity.
   *
   * No single measure handles every way a bank writes a name, so four are
   * combined: Jaro-Winkler for truncation, token set ratio for extra or
   * reordered words, TF-IDF over character 3-grams to weight the distinctive
   * part of the name, and prefix coverage for outright abbreviation. The blend
   * is then gated on sharing at least one distinctive word, which is what stops
   * "Maple Retail Services" matching "Nordlys Retail GmbH" on the word "Retail".
   */
  private payerSimilarity(candidate: string, name: string): number {
    if (!candidate || !name) return 0;

    const blended =
      0.33 * jaroWinkler(candidate, name) +
      0.27 * tokenSetRatio(candidate, name) +
      0.22 * this.tfidf.similarity(candidate, name) +
      0.10 * abbreviationCoverage(candidate, name) +
      0.08 * tokenJaccard(candidate, name);

    const candidateTokens = new Set(distinctiveTokens(candidate));
    const nameTokens = distinctiveTokens(name);
    if (nameTokens.length === 0 || candidateTokens.size === 0) return blended * 0.5;

    // A distinctive word counts as shared when it is present, or when one is a
    // clear prefix of the other ("ORBIS PKG" against "ORBIS PACKAGING").
    const sharesDistinctive = nameTokens.some((token) =>
      [...candidateTokens].some(
        (other) =>
          other === token ||
          (other.length >= 4 && token.startsWith(other)) ||
          (token.length >= 4 && other.startsWith(token)) ||
          isContractionOf(other, token) ||
          isContractionOf(token, other),
      ),
    );
    return sharesDistinctive ? blended : Math.min(blended, 0.45);
  }

  /** The best-matching customer for a narration, if any is convincing enough. */
  findPayer(narration: string): PayerMatch | null {
    const candidates = payerCandidates(narration);
    let best: PayerMatch | null = null;

    for (const customer of this.customers) {
      const names = this.normalizedNames.get(customer.customerId) ?? [];
      for (const name of names) {
        for (const candidate of candidates) {
          const score = this.payerSimilarity(candidate, name);
          if (!best || score > best.score) {
            best = {
              customerId: customer.customerId,
              customerName: customer.name,
              score,
              matchedOn: candidate,
            };
          }
        }
      }
    }
    return best && best.score >= PAYER_THRESHOLD ? best : null;
  }

  /** Invoice numbers written in the narration that resolve to a real invoice. */
  private resolveInvoiceRefs(narration: string): Array<{ invoice: Invoice; keyworded: boolean }> {
    const refs = extractInvoiceRefs(narration);
    const resolved: Array<{ invoice: Invoice; keyworded: boolean }> = [];
    for (const ref of refs) {
      const invoice = this.invoices.find((i) => invoiceNumberDigits(i.invoiceNumber) === ref.digits);
      if (invoice) resolved.push({ invoice, keyworded: ref.keyworded });
    }
    return resolved;
  }

  /** Date evidence. Returns null when the date rules the candidate out entirely. */
  private dateEvidence(
    txnDate: IsoDate,
    invoice: Invoice,
  ): { points: number; note: string } | null {
    if (txnDate < invoice.invoiceDate) {
      // Money cannot pay an invoice that did not exist on the day it arrived.
      return null;
    }
    const afterDue = daysBetween(txnDate, invoice.dueDate);
    if (afterDue < 0) return { points: W.dateBeforeDue, note: 'paid before the due date' };
    if (afterDue <= STALE_AFTER_DAYS) {
      return { points: W.datePlausibleAfterDue, note: `received ${afterDue} day(s) after the due date` };
    }
    return { points: W.dateStale, note: `received ${afterDue} days after the due date` };
  }

  /** How many open invoices anywhere in the book that exact amount could settle. */
  private countExactAmountMatches(amountMinor: number, currency: Currency): number {
    return this.invoices.filter(
      (i) =>
        isOutstanding(i) &&
        i.currency === currency &&
        (near(i.balanceDueMinor, amountMinor) ||
          near(i.totalMinor, amountMinor) ||
          near(i.totalMinor - tdsAmountMinor(i.subtotalMinor), amountMinor)),
    ).length;
  }

  /** Scores one receipt against one open invoice. */
  private scoreSingle(
    row: StatementRowInput,
    amountMinor: number,
    invoice: Invoice,
    payer: PayerMatch | null,
    refHit: { keyworded: boolean } | null,
    openForCustomer: number,
  ): Candidate | null {
    if (invoice.currency !== row.currency) return null;

    const date = this.dateEvidence(row.txnDate, invoice);
    if (!date) return null;

    const evidence: string[] = [];
    const reasons: string[] = [];
    let score = 0;

    if (refHit) {
      score += refHit.keyworded ? W.invoiceRefKeyworded : W.invoiceRefBare;
      evidence.push(
        refHit.keyworded
          ? `Narration quotes ${invoice.invoiceNumber}`
          : `Narration contains ${invoiceNumberDigits(invoice.invoiceNumber)}, which matches ${invoice.invoiceNumber}`,
      );
      reasons.push('invoice number in narration');
    }

    if (payer && payer.customerId === invoice.customerId) {
      score += W.payer * payer.score;
      evidence.push(
        `Payer "${payer.matchedOn}" matches ${payer.customerName} (${Math.round(payer.score * 100)}% name similarity)`,
      );
      reasons.push('payer name matches');
    }

    const tdsExpected = invoice.totalMinor - tdsAmountMinor(invoice.subtotalMinor);
    let tdsConsistent = false;
    let shortfall = 0;

    if (near(amountMinor, invoice.balanceDueMinor)) {
      score += W.amountExactBalance;
      evidence.push(`Amount equals the balance due of ${formatMoney(invoice.balanceDueMinor, invoice.currency)}`);
      reasons.push('exact amount');
    } else if (near(amountMinor, invoice.totalMinor)) {
      score += W.amountExactTotal;
      evidence.push(`Amount equals the invoice total of ${formatMoney(invoice.totalMinor, invoice.currency)}`);
      reasons.push('exact amount');
    } else if (near(amountMinor, tdsExpected) && invoice.taxName.toUpperCase().includes('GST')) {
      score += W.amountTdsAdjusted;
      tdsConsistent = true;
      shortfall = invoice.balanceDueMinor - amountMinor;
      evidence.push(
        `Amount equals the total less 10% TDS on the subtotal (${formatMoney(tdsAmountMinor(invoice.subtotalMinor), invoice.currency)} withheld)`,
      );
      reasons.push('exact amount after TDS');
    } else if (amountMinor < invoice.balanceDueMinor) {
      score += W.amountPartial;
      shortfall = invoice.balanceDueMinor - amountMinor;
      evidence.push(
        `Part payment: ${formatMoney(shortfall, invoice.currency)} would remain outstanding`,
      );
      reasons.push('part payment');
    } else {
      // More money than the invoice asks for, with no invoice number quoted, is
      // more likely to be a different invoice or several at once.
      if (!refHit) return null;
      shortfall = invoice.balanceDueMinor - amountMinor;
      evidence.push(
        `Amount exceeds the balance due by ${formatMoney(-shortfall, invoice.currency)}`,
      );
      reasons.push('amount larger than the balance');
    }

    if (
      (near(amountMinor, invoice.balanceDueMinor) || near(amountMinor, invoice.totalMinor)) &&
      this.countExactAmountMatches(amountMinor, row.currency) === 1
    ) {
      score += W.amountUniqueInBook;
      evidence.push('No other open invoice has this amount');
    }

    score += date.points;
    evidence.push(`Transaction dated ${row.txnDate}, ${date.note}`);

    if (openForCustomer === 1 && payer && payer.customerId === invoice.customerId) {
      score += W.onlyOpenInvoice;
      evidence.push('It is the only open invoice for this customer');
    }

    if (score <= 0) return null;

    return {
      allocations: [{ invoiceNumber: invoice.invoiceNumber, amountMinor }],
      invoices: [invoice],
      customerId: invoice.customerId,
      score,
      evidence,
      reason: capitalize(reasons.join(', ')),
      tdsConsistent,
      shortfallMinor: shortfall,
    };
  }

  /**
   * One payment settling several invoices at once.
   *
   * Customers routinely clear a month's invoices with a single transfer, so a
   * small exhaustive search over that customer's open invoices looks for a
   * subset whose balances add up to the receipt. The search is bounded to four
   * invoices, which is more than enough here and keeps it well away from the
   * combinatorial blow-up that an unbounded subset sum would bring.
   */
  private findCombination(
    row: StatementRowInput,
    amountMinor: number,
    payer: PayerMatch,
  ): Candidate | null {
    const open = this.invoices
      .filter(
        (i) =>
          i.customerId === payer.customerId &&
          isOutstanding(i) &&
          i.currency === row.currency &&
          i.invoiceDate <= row.txnDate,
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    if (open.length < 2) return null;

    let best: { subset: Invoice[]; tds: boolean } | null = null;

    const search = (index: number, chosen: Invoice[], sumBalance: number, sumTds: number): void => {
      if (chosen.length >= 2) {
        if (near(sumBalance, amountMinor)) {
          if (!best || chosen.length < best.subset.length) best = { subset: [...chosen], tds: false };
        } else if (near(sumTds, amountMinor)) {
          if (!best) best = { subset: [...chosen], tds: true };
        }
      }
      if (chosen.length === MAX_COMBINATION_SIZE || index >= open.length) return;
      // Balances only grow, so a running sum already past the receipt cannot be
      // rescued by adding more invoices.
      if (sumBalance > amountMinor + AMOUNT_TOLERANCE_MINOR) return;

      for (let i = index; i < open.length; i += 1) {
        const invoice = open[i]!;
        chosen.push(invoice);
        search(
          i + 1,
          chosen,
          sumBalance + invoice.balanceDueMinor,
          sumTds + invoice.balanceDueMinor - tdsAmountMinor(invoice.subtotalMinor),
        );
        chosen.pop();
      }
    };
    search(0, [], 0, 0);

    if (!best) return null;
    const found = best as { subset: Invoice[]; tds: boolean };

    const allocations: SuggestedAllocation[] = found.subset.map((invoice) => ({
      invoiceNumber: invoice.invoiceNumber,
      amountMinor: found.tds
        ? invoice.balanceDueMinor - tdsAmountMinor(invoice.subtotalMinor)
        : invoice.balanceDueMinor,
    }));

    let score = W.amountCombination + W.payer * payer.score;
    const evidence = [
      `Payer "${payer.matchedOn}" matches ${payer.customerName} (${Math.round(payer.score * 100)}% name similarity)`,
      `${found.subset.length} open invoices add up to ${formatMoney(amountMinor, row.currency)}${found.tds ? ' after 10% TDS' : ''}: ${found.subset
        .map((i) => i.invoiceNumber)
        .join(', ')}`,
    ];

    const latest = found.subset.reduce((a, b) => (a.dueDate > b.dueDate ? a : b));
    const date = this.dateEvidence(row.txnDate, latest);
    if (!date) return null;
    score += date.points;
    evidence.push(`Transaction dated ${row.txnDate}, ${date.note}`);

    return {
      allocations,
      invoices: found.subset,
      customerId: payer.customerId,
      score,
      evidence,
      reason: `Payer matches, ${found.subset.length} open invoices sum to the amount${found.tds ? ' after TDS' : ''}`,
      tdsConsistent: found.tds,
      shortfallMinor: found.subset.reduce((sum, i) => sum + i.balanceDueMinor, 0) - amountMinor,
    };
  }

  /**
   * Matches one statement row and returns the best suggestion with the runners
   * up, or null when nothing is convincing. The caller decides what to do with
   * it; nothing is applied to an invoice without a person approving it.
   */
  match(row: StatementRowInput): { best: MatchSuggestion | null; alternatives: MatchSuggestion[]; noMatchReason: string | null } {
    const amountMinor = row.creditMinor;
    if (amountMinor === null || amountMinor <= 0) {
      return { best: null, alternatives: [], noMatchReason: 'Not a receipt' };
    }

    const payer = this.findPayer(row.narration);
    const refs = this.resolveInvoiceRefs(row.narration);
    const openForCustomer = payer
      ? this.invoices.filter((i) => i.customerId === payer.customerId && isOutstanding(i)).length
      : 0;

    const candidates: Candidate[] = [];
    const considered = new Set<string>();

    const consider = (invoice: Invoice, refHit: { keyworded: boolean } | null): void => {
      if (considered.has(invoice.invoiceNumber)) return;
      considered.add(invoice.invoiceNumber);
      if (!isOutstanding(invoice)) return;
      const candidate = this.scoreSingle(row, amountMinor, invoice, payer, refHit, openForCustomer);
      if (candidate) candidates.push(candidate);
    };

    // 1. Invoice numbers written in the narration are the strongest signal.
    for (const ref of refs) consider(ref.invoice, { keyworded: ref.keyworded });

    // 2. Everything still open for the customer the narration names.
    if (payer) {
      for (const invoice of this.invoices) {
        if (invoice.customerId === payer.customerId) consider(invoice, null);
      }
      const combination = this.findCombination(row, amountMinor, payer);
      if (combination) candidates.push(combination);
    }

    // 3. With no payer and no invoice number, an amount that settles exactly one
    //    open invoice is still worth putting in front of a person.
    if (!payer && refs.length === 0 && this.countExactAmountMatches(amountMinor, row.currency) === 1) {
      for (const invoice of this.invoices) {
        if (
          isOutstanding(invoice) &&
          invoice.currency === row.currency &&
          (near(invoice.balanceDueMinor, amountMinor) || near(invoice.totalMinor, amountMinor))
        ) {
          consider(invoice, null);
        }
      }
    }

    if (candidates.length === 0) {
      return {
        best: null,
        alternatives: [],
        noMatchReason: payer
          ? `No open invoice for ${payer.customerName} fits this amount and date`
          : 'Payer not recognized and no invoice number in the narration',
      };
    }

    candidates.sort((a, b) => b.score - a.score);
    const [top, ...rest] = candidates as [Candidate, ...Candidate[]];

    // A near-tie between two different invoices is itself information: it lowers
    // confidence so the reviewer looks rather than clicks straight through.
    const runnerUp = rest[0];
    let penalty = 0;
    if (runnerUp && top.score - runnerUp.score < 5) {
      penalty = 12;
      top.evidence.push(
        `Close alternative: ${runnerUp.allocations.map((a) => a.invoiceNumber).join(', ')}`,
      );
    }

    const finalScore = clampScore(top.score - penalty);
    if (finalScore < SUGGESTION_THRESHOLD) {
      return {
        best: null,
        alternatives: rest.slice(0, 3).map((c) => toSuggestion(c, clampScore(c.score))),
        noMatchReason: 'No candidate scored high enough to suggest',
      };
    }

    return {
      best: toSuggestion(top, finalScore),
      alternatives: rest.slice(0, 3).map((c) => toSuggestion(c, clampScore(c.score))),
      noMatchReason: null,
    };
  }

  /** Classifies a row before matching: debits and bank entries are not receipts. */
  static classifyRow(row: StatementRowInput): { isReceipt: boolean; reason: string | null } {
    if (row.creditMinor === null || row.creditMinor <= 0) {
      return { isReceipt: false, reason: 'Money paid out, not a receipt' };
    }
    const bankGenerated = detectBankGenerated(row.narration);
    if (bankGenerated) return { isReceipt: false, reason: bankGenerated };
    return { isReceipt: true, reason: null };
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(98, Math.round(score)));
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function toSuggestion(candidate: Candidate, score: number): MatchSuggestion {
  return {
    allocations: candidate.allocations,
    score,
    reason: candidate.reason,
    evidence: candidate.evidence,
    tdsConsistent: candidate.tdsConsistent,
    shortfallMinor: candidate.shortfallMinor,
    customerId: candidate.customerId,
  };
}

export { detectBankGenerated };
