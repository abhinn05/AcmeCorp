/**
 * One customer: their balances, their invoices, their email history, and the
 * two actions that belong to them - correct the contact address, chase them now.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { InvoiceTable, Thread } from '../components/parts';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Stat,
  date,
  dateTime,
  formatMinor,
  useAction,
  useAsync,
} from '../components/ui';

export function CustomerDetailPage() {
  const { customerId = '' } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.customer(customerId), [customerId]);

  const [email, setEmail] = useState<string | null>(null);
  const saveEmail = useAction(api.updateCustomerEmail);
  const remind = useAction(api.runReminders);
  const [remindNote, setRemindNote] = useState<string | null>(null);

  // The detail endpoint sends invoices, not rolled-up balances, so the totals
  // are derived here from the same rows the invoice table below shows.
  const totals = useMemo(() => {
    const invoices = data?.invoices ?? [];
    const open = invoices.filter((invoice) => invoice.balanceDue.minor > 0);
    const overdue = open.filter((invoice) => invoice.isOverdue);
    const oldest = overdue
      .map((invoice) => invoice.dueDate)
      .sort((a, b) => a.localeCompare(b))[0];
    const sum = (rows: typeof invoices) =>
      rows.reduce((total, invoice) => total + invoice.balanceDue.minor, 0);
    return {
      invoiceCount: invoices.length,
      overdueCount: overdue.length,
      outstanding: sum(open),
      overdue: sum(overdue),
      oldestDueDate: oldest ?? null,
    };
  }, [data]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Loading what="customer" />;
  if (!data) return null;

  const contactEmail = email ?? data.contactEmail;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{data.name}</h1>
        <p>
          <Link to="/customers">Customers</Link> · {data.customerId} · {data.city}, {data.country}
        </p>
      </div>

      <div className="stats">
        <Stat label="Outstanding" value={formatMinor(totals.outstanding, data.currency)} />
        <Stat
          label="Overdue"
          value={formatMinor(totals.overdue, data.currency)}
          hint={`${totals.overdueCount} of ${totals.invoiceCount} invoices`}
        />
        <Stat label="Oldest due" value={date(totals.oldestDueDate)} />
        <Stat label="Currency" value={data.currency} hint={data.phone} />
      </div>

      <Card title="Contact">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="contact-email">
              Email the agent writes to ({data.contactName})
            </label>
            <input
              id="contact-email"
              type="email"
              value={contactEmail}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <button
            className="btn"
            disabled={saveEmail.pending || contactEmail === data.contactEmail}
            onClick={async () => {
              const updated = await saveEmail.invoke(data.customerId, contactEmail);
              if (updated) {
                setEmail(null);
                reload();
              }
            }}
          >
            {saveEmail.pending ? 'Saving...' : 'Save'}
          </button>
          <button
            className="btn btn-primary"
            disabled={remind.pending}
            onClick={async () => {
              const result = await remind.invoke({ customerId: data.customerId, force: true });
              if (result) {
                const sent = result.sent[0];
                setRemindNote(
                  sent
                    ? `Reminder sent to ${sent.to} for ${sent.invoices.join(', ')}.`
                    : (result.skipped[0]?.reason ??
                      result.errors[0]?.message ??
                      'Nothing to remind about.'),
                );
                reload();
              }
            }}
          >
            {remind.pending ? 'Sending...' : 'Send reminder now'}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Use a mailbox you control to watch the loop end to end: the agent sends here, and reads
          the reply from the organization inbox.
        </p>
        {saveEmail.error ? <ErrorNote message={saveEmail.error} /> : null}
        {remind.error ? <ErrorNote message={remind.error} /> : null}
        {remindNote ? <div className="note note-ok">{remindNote}</div> : null}
      </Card>

      <Card title="Invoices">
        <InvoiceTable invoices={data.invoices} />
      </Card>

      <Card title="Email history">
        {data.conversations.length === 0 ? (
          <Empty>No emails exchanged with this customer yet.</Empty>
        ) : (
          <div className="stack">
            {data.conversations.map((conversation) => (
              <div key={conversation.conversationId}>
                <div className="row">
                  <h3>{conversation.subject}</h3>
                  {conversation.needsAttention ? <Badge tone="bad">needs attention</Badge> : null}
                  <span className="muted">
                    {conversation.messageCount} messages · last{' '}
                    {dateTime(conversation.lastMessageAt)}
                  </span>
                </div>
                <Thread conversation={conversation} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
