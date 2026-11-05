/**
 * Every email thread, newest first: what the agent sent, what came back, and
 * what it decided each reply meant. This is the audit trail for the agent.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Thread } from '../components/parts';
import { Badge, Card, Empty, ErrorNote, Loading, dateTime, useAsync } from '../components/ui';

export function ConversationsPage() {
  const { data, error, loading, reload } = useAsync(() => api.conversations());
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Conversations</h1>
        <p>{data ? `${data.length} threads` : 'Loading...'}</p>
        <button className="btn btn-sm" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {loading && !data ? <Loading what="conversations" /> : null}

      {data && data.length === 0 ? (
        <Card>
          <Empty>
            No emails yet. Send reminders from the <Link to="/dashboard">dashboard</Link>, then
            reply to one from the customer mailbox.
          </Empty>
        </Card>
      ) : null}

      {data?.map((conversation) => {
        const open = openId === conversation.conversationId;
        return (
          <Card
            key={conversation.conversationId}
            title={
              <span className="row">
                {conversation.subject}
                {conversation.needsAttention ? <Badge tone="bad">needs attention</Badge> : null}
              </span>
            }
            action={
              <button
                className="btn btn-sm"
                onClick={() => setOpenId(open ? null : conversation.conversationId)}
              >
                {open
                  ? 'Hide'
                  : `Show ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`}
              </button>
            }
          >
            <p className="muted" style={{ marginTop: 0 }}>
              {conversation.customerId ? (
                <Link to={`/customers/${conversation.customerId}`}>{conversation.customerId}</Link>
              ) : (
                'unknown customer'
              )}{' '}
              · {conversation.customerEmail} · last message {dateTime(conversation.lastMessageAt)}
            </p>
            {open ? <Thread conversation={conversation} /> : null}
          </Card>
        );
      })}
    </div>
  );
}
