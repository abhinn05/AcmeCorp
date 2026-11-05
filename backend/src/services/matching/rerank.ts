import { formatMoney } from '../../domain/money.js';
import type { Invoice, MatchSuggestion, StatementLine } from '../../domain/types.js';
import { getLlmClient } from '../../integrations/llm.js';

/**
 * Optional re-ranking of ambiguous reconciliation rows.
 *
 * The assignment is explicit that the statement must not simply be handed to a
 * model, and it is not: by the time anything here runs, the local algorithms
 * have already produced a shortlist and scored it. The model is only ever
 * allowed to reorder that shortlist and improve the wording of the reason, and
 * only for rows the local scoring could not separate. It cannot introduce an
 * invoice that was not already a candidate, and it cannot raise a score beyond
 * the band that human review still applies to.
 *
 * This is switched off by default (RECON_LLM_RERANK=false) and the application
 * behaves identically without it.
 */

const SYSTEM_PROMPT = `You are helping an accounts team reconcile a bank statement.

A local matching algorithm has already shortlisted candidate invoices for one bank receipt and scored them. Your only job is to say which of the shortlisted candidates is most likely, and to write a one-line reason.

Rules:
- Choose only from the candidates given. Never name an invoice that is not on the list.
- If none of them is convincing, choose "none".
- Judge on the payer name in the narration, the amount, the currency and the dates.
- Reply with a single JSON object and nothing else:
  {"choice": "<candidate id or none>", "confidence": <0..1>, "reason": "<one short line>"}`;

interface RerankReply {
  choice?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

export async function rerankWithLlm(
  line: StatementLine,
  invoices: Invoice[],
): Promise<MatchSuggestion | null> {
  const llm = getLlmClient();
  if (!llm.available || line.creditMinor === null) return null;

  const candidates = [line.suggestion, ...line.alternatives].filter(
    (c): c is MatchSuggestion => c !== null,
  );
  if (candidates.length < 2) return null;

  const described = candidates.map((candidate, index) => {
    const detail = candidate.allocations
      .map((allocation) => {
        const invoice = invoices.find((i) => i.invoiceNumber === allocation.invoiceNumber);
        if (!invoice) return allocation.invoiceNumber;
        return `${invoice.invoiceNumber} (customer ${invoice.customerName}, invoiced ${invoice.invoiceDate}, due ${invoice.dueDate}, balance ${formatMoney(invoice.balanceDueMinor, invoice.currency)})`;
      })
      .join(' + ');
    return `  c${index}: ${detail} — local score ${candidate.score}, ${candidate.reason}`;
  });

  const user = [
    'BANK RECEIPT:',
    `  Date: ${line.txnDate}`,
    `  Narration: ${line.narration}`,
    `  Reference: ${line.reference ?? '(none)'}`,
    `  Amount received: ${formatMoney(line.creditMinor, line.currency)} ${line.currency}`,
    '',
    'SHORTLISTED CANDIDATES:',
    ...described,
  ].join('\n');

  const result = await llm.completeJson<RerankReply>({ system: SYSTEM_PROMPT, user });
  if (!result.ok || !result.data) return null;

  const choice = typeof result.data.choice === 'string' ? result.data.choice.trim() : '';
  if (choice === '' || choice.toLowerCase() === 'none') return null;

  const index = Number(choice.replace(/^c/i, ''));
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) return null;

  const chosen = candidates[index]!;
  const reason = typeof result.data.reason === 'string' ? result.data.reason.slice(0, 160) : chosen.reason;

  return {
    ...chosen,
    // Deliberately capped: a re-ranked row stays in the band a person reviews.
    score: Math.min(chosen.score + 5, CONFIDENCE_CAP),
    reason,
    evidence: [...chosen.evidence, 'Shortlist re-ranked by the language model'],
    rerankedByLlm: true,
  };
}

const CONFIDENCE_CAP = 69;
