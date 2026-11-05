# AcmeCorp Collections Agent

An accounts-receivable agent for a small business: it chases overdue invoices by
email, reads the replies and answers the ones it understands, escalates the rest
to a human, and matches incoming bank credits back to the invoices they pay.

Two services: an Express + MongoDB back end that owns every decision, and a React
front end that is only a view onto it. No credential, model key or mailbox
password ever reaches the browser.

---

## What it does

**Collections.** Overdue invoices are grouped per customer and sent one reminder
email, from the organization's accounts inbox, quoting the invoice numbers,
amounts, due dates and the bank details to pay into. A customer is never
reminded twice inside `REMINDER_MIN_INTERVAL_DAYS`.

**Replies.** A poller reads the accounts inbox, threads each reply onto the
conversation it belongs to, and classifies it: a question about an invoice, a
promise to pay, a dispute, a request for bank details, an out-of-office. What the
agent is confident about and can answer from the organization's own policies, it
answers. Everything else - low confidence, a dispute, a claim that fails
validation against the ledger - lands in **Needs attention** with the draft it
wrote, the reason it stopped, and an editable body for a human to approve.

**Reconciliation.** Upload a bank statement CSV. Every credit line is matched
against open invoices on amount, payer name, invoice and PO references in the
narration, dates, and anything a customer said by email about a payment they had
made. Each suggestion carries its score and the evidence behind it. A payment
short by exactly a TDS rate is recognised as withholding rather than a part
payment, and the human chooses whether to close the invoice or leave the balance
open. Nothing is applied to the ledger without a click.

## Layout

```
backend/
  src/domain/          money, dates, invoice arithmetic - no I/O
  src/services/        collections agent, matching, reconciliation, catalog
  src/integrations/    SMTP, IMAP, the LLM - each one swappable for a mock
  src/repositories/    MongoDB access, behind an interface
  src/routes/          the HTTP surface and its presenters
  test/                34 tests over matching and the agent's decisions
frontend/
  src/lib/api.ts       the only module that talks to the back end
  src/pages/           dashboard, customers, invoices, conversations,
                       needs attention, reconciliation, settings
data/                  seeded organization, customers, invoices, sample statement
```

Money is integer minor units everywhere; it becomes a formatted string only at
the HTTP edge. Amounts arrive from the browser in major units and are converted
at the route, so no fractional value reaches a business rule.

## Running it

Prerequisites: Node 20+, Docker (or a MongoDB you point at).

```bash
cp .env.example .env          # then fill it in - see below
docker compose up -d          # MongoDB on 27017, mongo-express on 8081

cd backend && npm install && npm run seed && npm run dev    # :4000
cd frontend && npm install && npm run dev                   # :5173
```

Open http://localhost:5173.

### Running it without a mailbox or an API key

The whole app runs with neither. Set in `.env`:

```
MAIL_TRANSPORT=mock     # outbound mail is written to backend/.mailbox/, the poller is off
LLM_ENABLED=false       # replies are classified by rules and queued for review
```

With `MAIL_TRANSPORT=smtp`, use a Gmail App Password (not the account password)
for both the SMTP and IMAP credentials. The LLM defaults to Google Gemini, whose
free tier is enough; any OpenAI-compatible provider works by setting
`LLM_PROVIDER=openai-compatible` and `LLM_BASE_URL`.

Every variable is documented in [.env.example](.env.example).

### Seeing the loop end to end

1. In **Settings**, point the accounts inbox at a mailbox you control.
2. In **Customers**, set one customer's contact email to a second mailbox you
   control, and press **Send reminder now**.
3. Reply from that mailbox - ask when the invoice was issued, or say the payment
   went out last Tuesday.
4. On the **Dashboard**, press **Check inbox for replies**. A confident question
   is answered immediately and appears in **Conversations**; a promise to pay or
   a dispute waits in **Needs attention**.
5. Upload `data/bank_statement_sample.csv` under **Reconciliation** and approve
   the matches.

**Reset demo data** on the dashboard puts invoices, conversations and
reconciliation back to the seeded state.

## Checks

```bash
cd backend  && npm run typecheck && npm test
cd frontend && npm run typecheck && npm run build
```

The tests cover the matching engine against the sample statement - cross-currency
receipts, abbreviated payer names, TDS shortfalls, split receipts, invoices raised
after the credit arrived, debits and bank-generated rows - and the agent's
decision to answer or escalate.

## Design notes

- **The agent never acts on an unverified claim.** A customer saying they paid
  does not mark an invoice paid; it becomes evidence a reconciliation suggestion
  can cite.
- **Matching is local.** Scoring is deterministic and testable. The model is only
  ever asked to re-rank candidates the local algorithms left ambiguous, behind
  `RECON_LLM_RERANK`, and the matching does not depend on it.
- **Escalation is a feature, not a failure.** `AGENT_AUTOSEND_MIN_CONFIDENCE`
  sets how certain the classifier must be before a reply goes out unread by a
  human.
- **Every integration has a mock.** Mail, inbox and model each degrade to
  something runnable, so the app is demonstrable with no external account.
