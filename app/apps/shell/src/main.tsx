import '@dinext/ui/trusted-types';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './router.tsx';
import { watchForNewRelease } from './shell/staleBuild.ts';

// A tab left open across a deploy reloads onto the new release instead of failing to open a page.
watchForNewRelease();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
