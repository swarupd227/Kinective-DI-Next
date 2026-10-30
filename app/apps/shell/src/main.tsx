import '@dinext/ui/trusted-types';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { z } from 'zod';
import { router } from './router.tsx';

// Zod's JIT compiles validators with new Function, which the CSP forbids (spec 11.9).
z.config({ jitless: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
