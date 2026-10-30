import '@dinext/ui/trusted-types';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { App } from './App.tsx';

// Zod's JIT compiles validators with new Function, which the CSP forbids (spec 11.9).
z.config({ jitless: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
