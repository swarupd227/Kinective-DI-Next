// @vitest-environment node
// Two browsers at once keep their own demo person, and neither sees the other's tasks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 18815;
const base = `http://localhost:${PORT}`;
let server: { close: () => Promise<void> };

beforeAll(async () => {
  const { startMockServer } = await import('../src/index.ts');
  server = startMockServer({ port: PORT, speed: 0.02, perBrowser: true });
}, 90_000);
afterAll(() => server.close(), 30_000);

/** A browser: it keeps the cookie the server gives it. */
function browser() {
  let cookie = '';
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, cookie } });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return res;
  };
}
const name = async (r: Response) => ((await r.json()) as { user: { name: string } }).user.name;

describe('a person per browser', () => {
  it('starts everyone on the default, and a switch stays in that browser', async () => {
    const [a, b] = [browser(), browser()];
    expect(await name(await a('/v1/session?persona=branch'))).toBe('Marcus Reed');
    expect(await name(await b('/v1/session'))).toBe('Dana Lee');
    expect(await name(await a('/v1/session'))).toBe('Marcus Reed');
    await b('/v1/session?persona=msr');
    expect(await name(await a('/v1/session'))).toBe('Marcus Reed');
    expect(await name(await b('/v1/session'))).toBe('Sofia Ruiz');
  });

  it('keeps tasks with the person who started them', async () => {
    const [a, b] = [browser(), browser()];
    await a('/v1/session?persona=branch');
    await b('/v1/session?persona=msr');
    const { threadId } = (await (await a('/v1/threads', { method: 'POST', body: '{}' })).json()) as { threadId: string };
    expect((await a(`/v1/threads/${threadId}`)).status).toBe(200);
    expect((await b(`/v1/threads/${threadId}`)).status).toBe(404);
  });
});
