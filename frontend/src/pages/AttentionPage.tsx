/**
 * The human-in-the-loop queue. A reply the agent would not send by itself -
 * low confidence, a promise to pay, a dispute, a validation issue - waits here
 * with the draft it wrote, the reason it stopped, and an editable body.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { AttentionItem } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Loading,
  dateTime,
  useAction,
  useAsync,
} from '../components/ui';

export function AttentionPage({ onResolved }: { onResolved: () => void }) {
  const { data, error, loading, reload } = useAsync(() => api.attention());
  const open = (data ?? []).filter((item) => item.status === 'open');
  const closed = (data ?? []).filter((item) => item.status !== 'open');

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Needs attention</h1>
        <p>
          {open.length === 0
            ? 'Nothing waiting on a human.'
            : `${open.length} reply${open.length === 1 ? '' : 'ies'} waiting for review`}
        </p>
        <button className="btn btn-sm" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading what="the queue" /> : null}

      {data && open.length === 0 ? (
        <Card>
          <Empty>
            The agent has answered everything it was confident about. Check the{' '}
            <Link to="/conversations">conversations</Link> to see what it sent.
          </Empty>
        </Card>
      ) : null}

      {open.map((item) => (
        <ReviewCard
          key={item.itemId}
          item={item}
          onDone={() => {
            reload();
            onResolved();
          }}
        />
      ))}

      {closed.length > 0 ? (
        <Card title="Already handled">
          <ul className="list-reset stack" style={{ gap: 8 }}>
            {closed.map((item) => (
              <li key={item.itemId} className="row">
                <Badge tone={item.status === 'sent' ? 'good' : 'neutral'}>{item.status}</Badge>
                <strong>{item.customerName}</strong>
                <span className="muted truncate">{item.subject}</span>
                <span className="muted">{dateTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function ReviewCard({ item, onDone }: { item: AttentionItem; onDone: () => void }) {
  const [body, setBody] = useState(item.draftBody);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setBody(item.draftBody);
  }, [item.itemId, item.draftBody]);

  const save = useAction(api.saveDraft);
  const send = useAction(api.sendReviewed);
  const dismiss = useAction(api.dismissAttention);

  return (
    <Card
      title={
        <span className="row">
          {item.customerName}
          <Badge tone="warn">{item.intent.replace(/_/g, ' ')}</Badge>
          <Badge tone="neutral">{Math.round(item.confidence * 100)}% confident</Badge>
        </span>
      }
      action={
        item.customerId ? (
          <Link className="btn btn-sm" to={`/customers/${item.customerId}`}>
            Open customer
          </Link>
        ) : null
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {item.fromAddress} · {item.subject} · {dateTime(item.createdAt)}
      </p>

      <div className="note note-info" style={{ display: 'block' }}>
        <strong>Why this stopped:</strong> {item.reason}
        {item.validationIssues.length > 0 ? (
          <ul className="evidence">
            {item.validationIssues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="split" style={{ marginTop: 14 }}>
        <div>
          <label>What the customer wrote</label>
          <div className="message inbound">
            <div className="message-body">{item.incomingBody}</div>
          </div>
        </div>
        <div>
          <label htmlFor={`draft-${item.itemId}`}>Reply to send (edit before sending)</label>
          <textarea
            id={`draft-${item.itemId}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-primary"
          disabled={send.pending || body.trim().length === 0}
          onClick={async () => {
            const result = await send.invoke(item.itemId, body);
            if (result) {
              setNote(
                result.warnings.length > 0
                  ? `Sent, with warnings: ${result.warnings.join('; ')}`
                  : 'Sent.',
              );
              onDone();
            }
          }}
        >
          {send.pending ? 'Sending...' : 'Approve and send'}
        </button>
        <button
          className="btn"
          disabled={save.pending || body === item.draftBody}
          onClick={async () => {
            const saved = await save.invoke(item.itemId, body);
            if (saved) setNote('Draft saved.');
          }}
        >
          {save.pending ? 'Saving...' : 'Save draft'}
        </button>
        <button
          className="btn btn-danger"
          disabled={dismiss.pending}
          onClick={async () => {
            if (!window.confirm('Dismiss without replying?')) return;
            const result = await dismiss.invoke(item.itemId);
            if (result) onDone();
          }}
        >
          {dismiss.pending ? 'Dismissing...' : 'Dismiss'}
        </button>
      </div>

      {save.error ? <ErrorNote message={save.error} /> : null}
      {send.error ? <ErrorNote message={send.error} /> : null}
      {dismiss.error ? <ErrorNote message={dismiss.error} /> : null}
      {note ? (
        <div className="note note-ok" style={{ marginTop: 10 }}>
          {note}
        </div>
      ) : null}
    </Card>
  );
}
