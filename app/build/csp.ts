// Spec 11.9 Content Security Policy, injected into production builds of every app. The dev server
// needs inline scripts for hot reload, so the policy applies at build time only.
// Additions to the spec: font-src allows data: for AG Grid's icon font, and Trusted Types allows
// only the "default" policy (packages/ui/src/trusted-types.ts).
import type { Plugin } from 'vite';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  'trusted-types default',
].join('; ');

export const csp = (): Plugin => ({
  name: 'dinext-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

/** Dev and preview servers proxy the Experience Layer (the mock server for now) to stay same-origin. */
export const experienceLayerProxy = { '/v1': { target: 'http://localhost:8787', changeOrigin: false, ws: true } };
