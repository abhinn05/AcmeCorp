/**
 * The shell: navigation, and one route per thing an accounts clerk does.
 *
 * The attention count lives here rather than inside the page that shows the
 * queue, because the point of the badge is to be visible from every other page.
 */
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { AttentionPage } from './pages/AttentionPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { CustomersPage } from './pages/CustomersPage';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const [attentionCount, setAttentionCount] = useState(0);

  const refreshAttention = useCallback(() => {
    api
      .attention()
      .then((items) => setAttentionCount(items.filter((item) => item.status === 'open').length))
      .catch(() => setAttentionCount(0));
  }, []);

  useEffect(() => {
    refreshAttention();
    const timer = window.setInterval(refreshAttention, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshAttention]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          AcmeCorp
          <small>Accounts receivable</small>
        </div>
        <nav className="nav">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/customers">Customers</NavLink>
          <NavLink to="/invoices">Invoices</NavLink>
          <NavLink to="/conversations">Conversations</NavLink>
          <NavLink to="/attention">
            Needs attention
            {attentionCount > 0 ? <span className="nav-count">{attentionCount}</span> : null}
          </NavLink>
          <NavLink to="/reconciliation">Reconciliation</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage onActivity={refreshAttention} />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/attention" element={<AttentionPage onResolved={refreshAttention} />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/reconciliation/:batchId" element={<ReconciliationPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}
