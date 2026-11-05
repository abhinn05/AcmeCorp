/** Who owes what, oldest debt first - the list a clerk works down. */
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Card, Empty, ErrorNote, Loading, date, money, useAsync } from '../components/ui';

export function CustomersPage() {
  const { data, error, loading, reload } = useAsync(() => api.customers());

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Customers</h1>
        <p>Outstanding and overdue balances, per customer.</p>
      </div>

      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading what="customers" /> : null}

      {data ? (
        <Card>
          {data.length === 0 ? (
            <Empty>No customers seeded.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Contact</th>
                    <th className="num">Invoices</th>
                    <th className="num">Outstanding</th>
                    <th className="num">Overdue</th>
                    <th>Oldest due</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((customer) => (
                    <tr key={customer.customerId}>
                      <td>
                        <Link to={`/customers/${customer.customerId}`}>{customer.name}</Link>
                        <div className="muted">
                          {customer.city}, {customer.country}
                        </div>
                      </td>
                      <td>
                        {customer.contactName}
                        <div className="muted">{customer.contactEmail}</div>
                      </td>
                      <td className="num">
                        {customer.invoiceCount}
                        {customer.overdueCount > 0 ? (
                          <>
                            {' '}
                            <Badge tone="bad">{customer.overdueCount} overdue</Badge>
                          </>
                        ) : null}
                      </td>
                      <td className="num">{money(customer.outstanding)}</td>
                      <td className="num">{money(customer.overdue)}</td>
                      <td>{date(customer.oldestDueDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
