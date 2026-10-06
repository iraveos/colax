import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import './styles/tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);