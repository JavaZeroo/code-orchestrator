import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './App';
import { queryClient } from './lib/queries';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <Toaster theme="dark" position="top-right" toastOptions={{ style: { background: '#1a1d24', border: '1px solid #333', color: '#d7dce4' } }} />
  </QueryClientProvider>,
);
