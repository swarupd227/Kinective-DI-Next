// @vitest-environment node
// The deployed container: the server serves the built shell and, when an access code is set, keeps
// everything behind it (a demo gate, not sign-in).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startMockServer } from '../src/index.ts';

const PORT = 18801;
const base = `http://localhost:${PORT}`;
const dist = mkdtempSync(join(tmpdir(), 'dinext-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>DI</title>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
writeFileSync(join(tmpdir(), 'dinext-secret.txt'), 'outside');
let server: { close: () => Promise<void> };

beforeAll(() => {
  server = startMockServer({ port: PORT, speed: 0.02, staticDir: dist, accessCode: 'open-sesame' });
});
afterAll(() => server.close());

const login = async () => {
  const r = await fetch(`${base}/demo-access`, { method: 'POST', body: new URLSearchParams({ code: 'open-sesame' }), redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
  expect(r.status).toBe(303);
  const cookie = r.headers.get('set-cookie')!;
  expect(cookie).toMatch(/^di_demo=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  return cookie.split(';')[0]!;
};

describe('demo access code', () => {
  it('sends pages to the code form, refuses the API and the socket, and answers health checks', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const page = await fetch(`${base}/c/thr_x`, { redirect: 'manual' });
    expect([page.status, page.headers.get('location')]).toEqual([303, '/demo-access']);
    expect((await fetch(`${base}/v1/session`)).status).toBe(401);
    const ws = new WebSocket(`ws://localhost:${PORT}/v1/stream?ticket=x`);
    const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
    expect((await fetch(`${base}/demo-access`, { method: 'POST', body: new URLSearchParams({ code: 'wrong' }) })).status).toBe(401);
  });

  it('lets a browser with the code in, and serves the app with deep links and cached assets', async () => {
    const cookie = await login();
    const headers = { cookie };
    expect((await fetch(`${base}/v1/session`, { headers })).status).toBe(200);
    const deep = await fetch(`${base}/reports/alco_monthly_pack`, { headers });
    expect([deep.status, await deep.text()]).toEqual([200, '<!doctype html><title>DI</title>']);
    expect(deep.headers.get('cache-control')).toBe('no-cache');
    const asset = await fetch(`${base}/assets/app-abc123.js`, { headers });
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('never serves files outside the build', async () => {
    const cookie = await login();
    const r = await fetch(`${base}/..%2Fdinext-secret.txt`, { headers: { cookie } });
    expect(await r.text()).not.toBe('outside');
  });
});
