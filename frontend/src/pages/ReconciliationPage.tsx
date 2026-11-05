/**
 * Bank statement reconciliation. Upload a CSV, and each credit line arrives
 * with the match the backend found, the evidence behind it, and any runner-up.
 * Nothing is ever applied without a click: approving is the human's act.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Batch, Invoice, StatementLine, Suggestion } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Loading,
  date,
  money,
  statusTone,
  useAction,
  useAsync,
} from '../components/ui';

export function ReconciliationPage() {
  const { batchId } = useParams();
  const navigate = useNavigate();

  const batches = useAsync(() => api.batches());
  const [parseErrors, setParseErrors] = useState<Array<{ line: number; message: string }>>([]);

  const upload = useAction(api.uploadStatement);
  const selected = batchId ?? batches.data?.[0]?.batchId ?? null;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Reconciliation</h1>
        <p>Match incoming credits to open invoices, then approve what is right.</p>
      </div>

      <Card title="Upload a bank statement">
        <div className="filebox">
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={upload.pending}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const result = await upload.invoke(file);
              event.target.value = '';
              if (result) {
                setParseErrors(result.parseErrors);
                batches.reload();
                navigate(`/reconciliation/${result.batch.batchId}`);
              }
            }}
          />
          <p className="muted" style={{ marginBottom: 0 }}>
            {upload.pending
              ? 'Parsing and matching...'
              : 'CSV with date, narration, reference, debit and credit columns. A sample sits in data/bank_statement_sample.csv.'}
          </p>
        </div>
        {upload.error ? <ErrorNote message={upload.error} /> : null}
        {parseErrors.length > 0 ? (
          <div className="note note-error" style={{ display: 'block', marginTop: 10 }}>
            <strong>Rows skipped:</strong>
            <ul className="evidence">
              {parseErrors.map((entry, index) => (
                <li key={index}>
                  Line {entry.line}: {entry.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      {batches.error ? <ErrorNote message={batches.error} onRetry={batches.reload} /> : null}
      {batches.loading && !batches.data ? <Loading what="batches" /> : null}

      {batches.data && batches.data.length === 0 ? (
        <Card>
          <Empty>No statement uploaded yet.</Empty>
        </Card>
      ) : null}

      {batches.data && batches.data.length > 0 ? (
        <Card title="Batches">
          <div className="row">
            {batches.data.map((batch: Batch) => (
              <button
                key={batch.batchId}
                className={`btn btn-sm${batch.batchId === selected ? ' btn-primary' : ''}`}
                onClick={() => navigate(`/reconciliation/${batch.batchId}`)}
              >
                {batch.filename} · {batch.receiptCount}/{batch.rowCount} receipts
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {selected ? <BatchLines batchId={selected} /> : null}
    </div>
  );
}

function BatchLines({ batchId }: { batchId: string }) {
  const { data, error, loading, reload, setData } = useAsync(() => api.batch(batchId), [batchId]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Loading what="statement lines" />;
  if (!data) return null;

  const pending = data.lines.filter((line) => line.status === 'pending');
  const settled = data.lines.filter((line) => line.status !== 'pending');

  const replaceLine = (line: StatementLine) =>
    setData((current) =>
      current
        ? { ...current, lines: current.lines.map((l) => (l.lineId === line.lineId ? line : l)) }
        : current,
    );

  return (
    <div className="stack">
      <div className="page-head">
        <h2>
          {data.batch.filename} · {pending.length} awaiting a decision
        </h2>
        <p>
          {data.batch.rowCount} rows, {data.batch.receiptCount} of them receipts · uploaded{' '}
          {date(data.batch.uploadedAt)}
        </p>
      </div>

      {pending.length === 0 ? (
        <Card>
          <Empty>Every receipt in this batch has been decided.</Empty>
        </Card>
      ) : null}

      {pending.map((line) => (
        <LineCard key={line.lineId} line={line} onDecided={replaceLine} />
      ))}

      {settled.length > 0 ? (
        <Card title="Decided and non-receipt rows">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Date</th>
                  <th>Narration</th>
                  <th className="num">Credit</th>
                  <th className="num">Debit</th>
                  <th>Status</th>
                  <th>Applied to</th>
                </tr>
              </thead>
              <tbody>
                {settled.map((line) => (
                  <tr key={line.lineId}>
                    <td className="num">{line.rowNumber}</td>
                    <td>{date(line.txnDate)}</td>
                    <td>
                      <span className="truncate" title={line.narration}>
                        {line.narration}
                      </span>
                      {line.nonReceiptReason ? (
                        <div className="muted">{line.nonReceiptReason}</div>
                      ) : null}
                    </td>
                    <td className="num">{money(line.credit)}</td>
                    <td className="num">{money(line.debit)}</td>
                    <td>
                      <Badge tone={statusTone(line.status)}>{line.status}</Badge>
                    </td>
                    <td className="mono">
                      {line.decision?.allocations
                        .map((a) => `${a.invoiceNumber} ${a.amount.formatted}`)
                        .join(', ') || '—'}
                      {line.decision?.note ? (
                        <div className="muted">{line.decision.note}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** One credit line: the suggestion, the alternatives, and a manual override. */
function LineCard({
  line,
  onDecided,
}: {
  line: StatementLine;
  onDecided: (line: StatementLine) => void;
}) {
  const suggestion = line.suggestion;
  const [manual, setManual] = useState(false);
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState<'close_tds' | 'leave_open' | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const approve = useAction(api.approveLine);
  const reject = useAction(api.rejectLine);
  const choices = useAsync<Invoice[]>(
    () => (manual ? api.lineChoices(line.lineId) : Promise.resolve([])),
    [manual, line.lineId],
  );

  useEffect(() => {
    if (suggestion && suggestion.shortfall.minor > 0 && suggestion.tdsConsistent) {
      setChoice('close_tds');
    }
  }, [suggestion]);

  const manualAllocations = useMemo(
    () =>
      Object.entries(picked)
        .map(([invoiceNumber, amount]) => ({ invoiceNumber, amount: Number(amount) }))
        .filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0),
    [picked],
  );

  const applySuggestion = async (chosen: Suggestion) => {
    const result = await approve.invoke(line.lineId, {
      allocations: chosen.allocations.map((allocation) => ({
        invoiceNumber: allocation.invoiceNumber,
        amount: allocation.amount.amount,
      })),
      choice,
      note: note.trim() || null,
    });
    if (result) onDecided(result.line);
  };

  return (
    <Card
      title={
        <span className="row">
          Row {line.rowNumber} · {money(line.credit)}
          <Badge tone="warn">pending</Badge>
        </span>
      }
      action={
        <button className="btn btn-sm" onClick={() => setManual((value) => !value)}>
          {manual ? 'Hide manual match' : 'Match manually'}
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {date(line.txnDate)} · {line.narration}
        {line.reference ? ` · ref ${line.reference}` : ''}
      </p>

      {!suggestion ? (
        <div className="note note-error" style={{ display: 'block' }}>
          No invoice matched this credit. Match it manually, or reject the row.
        </div>
      ) : (
        <SuggestionBlock
          suggestion={suggestion}
          heading="Best match"
          onApply={() => applySuggestion(suggestion)}
          pending={approve.pending}
        />
      )}

      {line.alternatives.length > 0 ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <h3>Other candidates</h3>
          {line.alternatives.map((alternative, index) => (
            <SuggestionBlock
              key={index}
              suggestion={alternative}
              heading={`Alternative ${index + 1}`}
              onApply={() => applySuggestion(alternative)}
              pending={approve.pending}
            />
          ))}
        </div>
      ) : null}

      {line.linkedMessages.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <h3>Emails that mention this payment</h3>
          <ul className="evidence">
            {line.linkedMessages.map((message) => (
              <li key={message.messageId}>
                {message.customerId}
                {message.reference ? ` · ref ${message.reference}` : ''}: {message.snippet}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggestion && suggestion.shortfall.minor > 0 ? (
        <div className="note note-info" style={{ display: 'block', marginTop: 12 }}>
          <strong>Short by {money(suggestion.shortfall)}.</strong>{' '}
          {suggestion.tdsConsistent
            ? 'The gap matches a TDS deduction, so closing the invoice is the usual call.'
            : 'The gap does not match a TDS rate, so this may be a part payment.'}
          <div className="row" style={{ marginTop: 8 }}>
            <label className="row" style={{ gap: 6, marginBottom: 0 }}>
              <input
                type="radio"
                style={{ width: 'auto' }}
                checked={choice === 'close_tds'}
                onChange={() => setChoice('close_tds')}
              />
              Close the invoice (TDS withheld)
            </label>
            <label className="row" style={{ gap: 6, marginBottom: 0 }}>
              <input
                type="radio"
                style={{ width: 'auto' }}
                checked={choice === 'leave_open'}
                onChange={() => setChoice('leave_open')}
              />
              Leave the balance open
            </label>
          </div>
        </div>
      ) : null}

      {manual ? (
        <div style={{ marginTop: 12 }}>
          <h3>Manual match</h3>
          {choices.error ? <ErrorNote message={choices.error} onRetry={choices.reload} /> : null}
          {choices.loading ? <Loading what="open invoices" /> : null}
          {choices.data?.length === 0 ? <Empty>No open invoices to match against.</Empty> : null}
          {choices.data?.map((invoice) => {
            const value = picked[invoice.invoiceNumber] ?? '';
            return (
              <div className="picker" key={invoice.invoiceNumber}>
                <input
                  type="checkbox"
                  checked={value !== ''}
                  onChange={(event) =>
                    setPicked((current) => {
                      const next = { ...current };
                      if (event.target.checked) {
                        next[invoice.invoiceNumber] = String(invoice.balanceDue.amount);
                      } else {
                        delete next[invoice.invoiceNumber];
                      }
                      return next;
                    })
                  }
                />
                <span className="mono">{invoice.invoiceNumber}</span>
                <span>{invoice.customerName}</span>
                <span className="muted">
                  due {date(invoice.dueDate)} · balance {money(invoice.balanceDue)}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="amount"
                  value={value}
                  onChange={(event) =>
                    setPicked((current) => ({
                      ...current,
                      [invoice.invoiceNumber]: event.target.value,
                    }))
                  }
                />
              </div>
            );
          })}
          <button
            className="btn btn-primary"
            style={{ marginTop: 10 }}
            disabled={approve.pending || manualAllocations.length === 0}
            onClick={async () => {
              const result = await approve.invoke(line.lineId, {
                allocations: manualAllocations,
                choice,
                note: note.trim() || null,
              });
              if (result) onDecided(result.line);
            }}
          >
            {approve.pending ? 'Applying...' : 'Apply this allocation'}
          </button>
        </div>
      ) : null}

      <div className="field" style={{ marginTop: 12, maxWidth: 520 }}>
        <label htmlFor={`note-${line.lineId}`}>Note (kept with the decision)</label>
        <input
          id={`note-${line.lineId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional: why this call was made"
        />
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn btn-danger"
          disabled={reject.pending}
          onClick={async () => {
            const result = await reject.invoke(line.lineId, note.trim() || undefined);
            if (result) onDecided(result);
          }}
        >
          {reject.pending ? 'Rejecting...' : 'Reject this row'}
        </button>
      </div>

      {approve.error ? <ErrorNote message={approve.error} /> : null}
      {reject.error ? <ErrorNote message={reject.error} /> : null}
    </Card>
  );
}

function SuggestionBlock({
  suggestion,
  heading,
  onApply,
  pending,
}: {
  suggestion: Suggestion;
  heading: string;
  onApply: () => void;
  pending: boolean;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginTop: 10,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <strong>{heading}</strong>
          {/* The backend scores a candidate out of 100, not out of 1. */}
          <Badge tone={suggestion.score >= 75 ? 'good' : 'warn'}>
            score {Math.round(suggestion.score)}
          </Badge>
          {suggestion.rerankedByLlm ? <Badge tone="accent">re-ranked by model</Badge> : null}
        </div>
        <button className="btn btn-sm btn-primary" disabled={pending} onClick={onApply}>
          {pending ? 'Applying...' : 'Approve'}
        </button>
      </div>

      <p className="muted" style={{ margin: '6px 0 0' }}>
        {suggestion.reason}
      </p>

      <ul className="evidence">
        {suggestion.allocations.map((allocation) => (
          <li key={allocation.invoiceNumber}>
            <span className="mono">{allocation.invoiceNumber}</span> → {money(allocation.amount)}
          </li>
        ))}
        {suggestion.evidence.map((item, index) => (
          <li key={`evidence-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
