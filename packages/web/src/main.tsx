import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './App';
import { queryClient } from './lib/queries';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <Toaster
      theme="dark"
      position="top-right"
      toastOptions={{
        style: {
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-line)',
          color: 'var(--color-ink)',
        },
      }}
    />
  </QueryClientProvider>,
);
