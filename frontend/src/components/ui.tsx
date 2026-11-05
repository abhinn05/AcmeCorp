/**
 * The small set of pieces every page is built from. Keeping them here means a
 * page file contains only the behaviour that is specific to that page.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Money } from '../lib/api';

/** Runs an async read on mount, re-runs it on `reload()`, and reports failure. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/** An action the user triggers: tracks its own pending state and its outcome. */
export function useAction<Args extends unknown[], T>(run: (...args: Args) => Promise<T>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invoke = useCallback(
    async (...args: Args): Promise<T | null> => {
      setPending(true);
      setError(null);
      try {
        return await run(...args);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { invoke, pending, error, clearError: () => setError(null) };
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}...</p>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note note-error">
      <span>{message}</span>
      {onRetry ? (
        <button className="btn btn-quiet" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}

export function Card({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {title || action ? (
        <header className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function money(value: Money | null | undefined): string {
  return value ? value.formatted : '—';
}

/** Minor units from the API, formatted the way the API formats a Money. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function statusTone(status: string): string {
  switch (status) {
    case 'paid':
    case 'approved':
      return 'good';
    case 'rejected':
    case 'overdue':
      return 'bad';
    case 'pending':
    case 'sent':
      return 'warn';
    default:
      return 'neutral';
  }
}
