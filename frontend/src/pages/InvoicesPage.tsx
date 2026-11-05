/** Every invoice, with the two filters that matter: status and overdue. */
import { useState } from 'react';
import { api } from '../lib/api';
import { InvoiceTable } from '../components/parts';
import { Card, ErrorNote, Loading, useAsync } from '../components/ui';

export function InvoicesPage() {
  const [status, setStatus] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const { data, error, loading, reload } = useAsync(
    () => api.invoices({ status: status || undefined, overdue: overdueOnly || undefined }),
    [status, overdueOnly],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Invoices</h1>
        <p>{data ? `${data.length} shown` : 'Loading...'}</p>
      </div>

      <Card>
        <div className="row">
          <div className="field" style={{ maxWidth: 180 }}>
            <label htmlFor="status">Status</label>
            <select id="status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="paid">Paid</option>
            </select>
          </div>
          <label className="row" style={{ marginTop: 18, gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.target.checked)}
            />
            Overdue only
          </label>
        </div>
      </Card>

      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading what="invoices" /> : null}
      {data ? (
        <Card>
          <InvoiceTable invoices={data} showCustomer />
        </Card>
      ) : null}
    </div>
  );
}
