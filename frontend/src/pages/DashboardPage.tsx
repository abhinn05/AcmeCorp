/**
 * The dashboard answers two questions at a glance - how much is owed, and what
 * is waiting on a human - and holds the three buttons that drive the agent:
 * send reminders, check the inbox, reset the demo.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Stat,
  date,
  formatMinor,
  useAction,
  useAsync,
} from '../components/ui';

type RemindersResult = Awaited<ReturnType<typeof api.runReminders>>;
type InboxResult = Awaited<ReturnType<typeof api.checkInbox>>;

export function DashboardPage({ onActivity }: { onActivity: () => void }) {
  const dashboard = useAsync(() => api.dashboard());
  const health = useAsync(() => api.health());

  const reminders = useAction(api.runReminders);
  const inbox = useAction(api.checkInbox);
  const reset = useAction(api.resetDemo);

  const [reminderRun, setReminderRun] = useState<RemindersResult | null>(null);
  const [inboxRun, setInboxRun] = useState<InboxResult | null>(null);
  const [resetNote, setResetNote] = useState<string | null>(null);

  const refresh = () => {
    dashboard.reload();
    health.reload();
    onActivity();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Dashboard</h1>
        {dashboard.data ? <p>As of {date(dashboard.data.asOf)}</p> : null}
      </div>

      {dashboard.error ? <ErrorNote message={dashboard.error} onRetry={dashboard.reload} /> : null}
      {dashboard.loading && !dashboard.data ? <Loading what="totals" /> : null}

      {dashboard.data ? (
        <div className="stats">
          {dashboard.data.outstandingByCurrency.map((entry) => (
            <Stat
              key={entry.currency}
              label={`Outstanding ${entry.currency}`}
              value={formatMinor(entry.outstandingMinor, entry.currency)}
              hint={`${formatMinor(entry.overdueMinor, entry.currency)} overdue`}
            />
          ))}
          <Stat
            label="Invoices"
            value={dashboard.data.invoiceCount}
            hint={`${dashboard.data.overdueCount} overdue`}
          />
          <Stat label="Customers" value={dashboard.data.customerCount} />
          <Stat label="Conversations" value={dashboard.data.conversationCount} />
          <Stat
            label="Needs attention"
            value={dashboard.data.needsAttentionCount}
            hint={
              dashboard.data.needsAttentionCount > 0
                ? 'A reply is waiting for review'
                : 'Nothing queued'
            }
          />
        </div>
      ) : null}

      <Card title="Run the agent">
        <p className="muted">
          The agent also runs on its own schedule. These buttons do the same work now, so a demo
          does not have to wait for a timer.
        </p>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            disabled={reminders.pending}
            onClick={async () => {
              const result = await reminders.invoke({});
              if (result) setReminderRun(result);
              refresh();
            }}
          >
            {reminders.pending ? 'Sending...' : 'Send overdue reminders'}
          </button>
          <button
            className="btn"
            disabled={inbox.pending}
            onClick={async () => {
              const result = await inbox.invoke();
              if (result) setInboxRun(result);
              refresh();
            }}
          >
            {inbox.pending ? 'Checking...' : 'Check inbox for replies'}
          </button>
          <button
            className="btn btn-danger"
            disabled={reset.pending}
            onClick={async () => {
              if (
                !window.confirm(
                  'Reset invoices, conversations and reconciliation to the seeded state?',
                )
              ) {
                return;
              }
              const result = await reset.invoke(true);
              if (result) setResetNote(result.message);
              setReminderRun(null);
              setInboxRun(null);
              refresh();
            }}
          >
            {reset.pending ? 'Resetting...' : 'Reset demo data'}
          </button>
        </div>

        <div className="stack" style={{ marginTop: 12 }}>
          {reminders.error ? <ErrorNote message={reminders.error} /> : null}
          {inbox.error ? <ErrorNote message={inbox.error} /> : null}
          {reset.error ? <ErrorNote message={reset.error} /> : null}
          {resetNote ? <div className="note note-ok">{resetNote}</div> : null}
        </div>
      </Card>

      <div className="split">
        <Card title="System checks">
          {health.error ? <ErrorNote message={health.error} onRetry={health.reload} /> : null}
          {health.loading && !health.data ? <Loading what="checks" /> : null}
          {health.data ? (
            <ul className="list-reset stack" style={{ gap: 10 }}>
              <li className="row">
                <Badge tone={health.data.mail.ok ? 'good' : 'bad'}>
                  mail · {health.data.mail.transport}
                </Badge>
                <span className="muted">{health.data.mail.detail}</span>
              </li>
              <li className="row">
                <Badge
                  tone={
                    health.data.inbox.available ? (health.data.inbox.ok ? 'good' : 'bad') : 'neutral'
                  }
                >
                  inbox
                </Badge>
                <span className="muted">{health.data.inbox.detail}</span>
              </li>
              <li className="row">
                <Badge tone={health.data.llm.configured ? 'good' : 'neutral'}>model</Badge>
                <span className="muted">
                  {health.data.llm.configured
                    ? `${health.data.llm.model} · replies drafted by the model`
                    : 'No model configured — replies are classified by rules and queued for review'}
                </span>
              </li>
              <li className="row">
                <Badge tone="neutral">timezone</Badge>
                <span className="muted">
                  {health.data.timezone} · today is {health.data.today}
                </span>
              </li>
              <li className="row">
                <Badge tone={health.data.reconciliationRerank ? 'accent' : 'neutral'}>re-rank</Badge>
                <span className="muted">
                  {health.data.reconciliationRerank
                    ? 'Ambiguous payment matches are re-ranked by the model'
                    : 'Payment matching is fully local'}
                </span>
              </li>
            </ul>
          ) : null}
        </Card>

        <Card title="Last run">
          <div className="stack">
            {!reminderRun && !inboxRun && !reminders.pending && !inbox.pending ? (
              <Empty>Nothing run yet in this session.</Empty>
            ) : null}

            {reminders.pending ? <p className="muted">Sending reminders...</p> : null}
            {reminderRun ? (
              <div>
                <h3>Reminders</h3>
                <p className="muted">
                  {reminderRun.sent.length} sent · {reminderRun.skipped.length} skipped ·{' '}
                  {reminderRun.errors.length} failed
                </p>
                <ul className="evidence">
                  {reminderRun.sent.map((entry) => (
                    <li key={`${entry.to}-${entry.invoices.join('-')}`}>
                      {entry.customerName} → {entry.to} ({entry.invoices.join(', ')})
                    </li>
                  ))}
                  {reminderRun.skipped.map((entry) => (
                    <li key={`skip-${entry.customerId}`}>
                      {entry.customerId}: {entry.reason}
                    </li>
                  ))}
                  {reminderRun.errors.map((entry) => (
                    <li key={`err-${entry.customerId}`}>
                      {entry.customerId}: {entry.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {inbox.pending ? <p className="muted">Reading the inbox...</p> : null}
            {inboxRun ? (
              <div>
                <h3>Inbox</h3>
                <p className="muted">
                  {inboxRun.fetched} fetched · {inboxRun.answered} answered · {inboxRun.escalated}{' '}
                  queued for review · {inboxRun.ignored} ignored
                </p>
                <ul className="evidence">
                  {inboxRun.details.map((entry, index) => (
                    <li key={index}>
                      {entry.from} — {entry.subject} → {entry.outcome}
                      {entry.intent ? ` (${entry.intent})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card title="Next step">
        <p className="muted">
          Replies the agent would not answer by itself land in{' '}
          <Link to="/attention">Needs attention</Link>. Bank statements are matched to invoices
          under <Link to="/reconciliation">Reconciliation</Link>.
        </p>
      </Card>
    </div>
  );
}
