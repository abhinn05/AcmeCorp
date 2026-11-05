/**
 * The organization's own details: what the agent quotes in an email, and the
 * one field a demo needs to change - the inbox it sends from and reads.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { Card, ErrorNote, Loading, useAction, useAsync } from '../components/ui';

export function SettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.organization());
  const [email, setEmail] = useState<string | null>(null);
  const save = useAction(api.updateAccountsEmail);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Loading what="organization" />;
  if (!data) return null;

  const accountsEmail = email ?? data.accountsEmail;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Settings</h1>
        <p>{data.name}</p>
      </div>

      <Card title="Accounts inbox">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="accounts-email">Address the agent sends from and reads replies at</label>
            <input
              id="accounts-email"
              type="email"
              value={accountsEmail}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={save.pending || accountsEmail === data.accountsEmail}
            onClick={async () => {
              const updated = await save.invoke(accountsEmail);
              if (updated) {
                setEmail(null);
                reload();
              }
            }}
          >
            {save.pending ? 'Saving...' : 'Save'}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          The mailbox credentials themselves live in the back end&apos;s .env and never reach the
          browser. This only changes the address shown to customers.
        </p>
        {save.error ? <ErrorNote message={save.error} /> : null}
      </Card>

      <div className="split">
        <Card title="Organization">
          <dl className="list-reset stack" style={{ gap: 8, margin: 0 }}>
            <Row label="Address" value={data.address} />
            <Row label="Accounts contact" value={data.accountsContactName} />
            <Row label="Phone" value={data.phone} />
            <Row label="Default currency" value={data.defaultCurrency} />
            <Row label="Accepted currencies" value={data.acceptedCurrencies.join(', ')} />
            <Row label="Payment terms" value={data.paymentTerms} />
            <Row label="Payment methods" value={data.paymentMethods.join(', ')} />
          </dl>
        </Card>

        <Card title="Bank details quoted in emails">
          <dl className="list-reset stack" style={{ gap: 8, margin: 0 }}>
            <Row label="Account name" value={data.bankDetails.accountName} />
            <Row label="Account number" value={data.bankDetails.accountNumber} />
            <Row label="Bank" value={data.bankDetails.bank} />
            <Row label="IFSC" value={data.bankDetails.ifsc} />
            <Row label="SWIFT" value={data.bankDetails.swiftCode} />
          </dl>
        </Card>
      </div>

      <Card title="Policies the agent answers from">
        <dl className="list-reset stack" style={{ gap: 10, margin: 0 }}>
          {Object.entries(data.policies).map(([key, value]) => (
            <Row key={key} label={key.replace(/_/g, ' ')} value={value} />
          ))}
        </dl>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="muted" style={{ textTransform: 'capitalize' }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
