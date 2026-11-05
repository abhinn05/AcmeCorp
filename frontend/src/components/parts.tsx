/** Two views that more than one page needs: a list of invoices, and a thread. */
import type { Conversation, Invoice } from '../lib/api';
import { Badge, Empty, date, dateTime, money, statusTone } from './ui';

export function InvoiceTable({
  invoices,
  showCustomer = false,
}: {
  invoices: Invoice[];
  showCustomer?: boolean;
}) {
  if (invoices.length === 0) return <Empty>No invoices match.</Empty>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Invoice</th>
            {showCustomer ? <th>Customer</th> : null}
            <th>Issued</th>
            <th>Due</th>
            <th>Status</th>
            <th className="num">Total</th>
            <th className="num">Paid</th>
            <th className="num">Balance</th>
            <th className="num">Reminders</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.invoiceNumber}>
              <td>
                <span className="mono">{invoice.invoiceNumber}</span>
                {invoice.poNumber ? <div className="muted">PO {invoice.poNumber}</div> : null}
              </td>
              {showCustomer ? <td>{invoice.customerName}</td> : null}
              <td>{date(invoice.invoiceDate)}</td>
              <td>
                {date(invoice.dueDate)}
                {invoice.isOverdue ? (
                  <div>
                    <Badge tone="bad">{invoice.daysOverdue}d overdue</Badge>
                  </div>
                ) : null}
              </td>
              <td>
                <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
              </td>
              <td className="num">{money(invoice.total)}</td>
              <td className="num">{money(invoice.amountPaid)}</td>
              <td className="num">{money(invoice.balanceDue)}</td>
              <td className="num">
                {invoice.reminderCount}
                {invoice.lastReminderAt ? (
                  <div className="muted">{date(invoice.lastReminderAt)}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Thread({ conversation }: { conversation: Conversation }) {
  return (
    <div>
      {conversation.messages.map((message) => (
        <article key={message.messageId} className={`message ${message.direction}`}>
          <div className="message-head">
            <strong>{message.direction === 'inbound' ? message.from : message.to}</strong>
            <Badge tone={message.direction === 'inbound' ? 'warn' : 'accent'}>
              {message.direction === 'inbound' ? 'from customer' : message.kind.replace(/_/g, ' ')}
            </Badge>
            <span>{dateTime(message.createdAt)}</span>
            {message.intent ? (
              <span>
                intent: {message.intent}
                {message.confidence !== null ? ` (${Math.round(message.confidence * 100)}%` : ''}
                {message.confidence !== null && message.classifiedBy
                  ? `, ${message.classifiedBy})`
                  : message.confidence !== null
                    ? ')'
                    : ''}
              </span>
            ) : null}
            {message.relatedInvoiceNumbers.length > 0 ? (
              <span className="mono">{message.relatedInvoiceNumbers.join(', ')}</span>
            ) : null}
          </div>
          <div className="message-body">{message.body}</div>
        </article>
      ))}
    </div>
  );
}
