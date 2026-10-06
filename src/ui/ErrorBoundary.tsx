import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ShieldIcon } from './icons.tsx';

/**
 * Catches render errors so a bug shows a readable message instead of a blank
 * page. Without this, any exception in the tree unmounts the whole app and the
 * user is left staring at nothing.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Colax crashed while rendering:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="lock">
        <div className="lock__card">
          <div className="lock__brand">
            <div className="lock__mark" style={{ background: 'var(--danger)' }}>
              <ShieldIcon width="28" height="28" />
            </div>
            <div>
              <h1 className="lock__title">Something went wrong</h1>
              <p className="lock__hint">
                Colax hit an unexpected error and stopped rendering. Your vault data is untouched on this
                device.
              </p>
            </div>
          </div>

          <div className="alert alert--danger">
            <code style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-word' }}>{error.message}</code>
          </div>

          <button className="btn btn--primary btn--block" onClick={() => location.reload()}>
            Reload Colax
          </button>
        </div>
      </div>
    );
  }
}