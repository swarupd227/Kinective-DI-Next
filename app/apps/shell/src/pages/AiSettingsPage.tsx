// Settings › AI connection (administrators): the Anthropic API key DI's agents use. An administrator
// pastes a new key, tests it, and saves it; only a key that works is saved, encrypted, and DI switches
// to it at once. The key is never shown again: the page sees its last four characters, who set it and
// when, and the last connection test. Keys are typed here, never in a chat with DI.
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, KeyRound, PlugZap, TriangleAlert } from 'lucide-react';
import { Badge, Button, Skeleton, TextInput } from '@dinext/ui';
import type { AiConnection, AiKeyTest } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './AiSettingsPage.module.css';

const SOURCE: Record<AiConnection['source'], string> = {
  settings: 'Set on this page',
  deployment: 'From the deployment (the app’s configuration)',
  none: 'None: DI answers with its offline planner',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function Result({ r }: { r: AiKeyTest | { ok: boolean; message: string } }) {
  return (
    <p className={r.ok ? styles.ok : styles.bad} role="status">
      {r.ok ? <CircleCheck size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />}
      {r.message}
      {'ms' in r && r.ms ? <span className={styles.ms}> ({r.ms} ms)</span> : null}
    </p>
  );
}

export function AiSettingsPage() {
  const { api } = useSession();
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['settings', 'ai'], queryFn: () => api.aiConnection() });
  const [key, setKey] = useState('');
  const testCurrent = useMutation({ mutationFn: () => api.testAiKey(), onSuccess: () => void client.invalidateQueries({ queryKey: ['settings', 'ai'] }) });
  const testNew = useMutation({ mutationFn: (k: string) => api.testAiKey(k) });
  const save = useMutation({
    mutationFn: (k: string) => api.saveAiKey(k),
    onSuccess: (r) => {
      // A saved key is cleared from the screen at once; a refused one stays so it can be corrected.
      if (r.ok) setKey('');
      void client.invalidateQueries({ queryKey: ['settings', 'ai'] });
    },
  });

  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/settings/ai', label: 'AI connection' });
  }, []);

  const s = status.data;
  const entered = key.trim();
  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (entered) save.mutate(entered);
  };

  return (
    <div className={`${page.page} ${page.narrow}`}>
      <header className={page.header}>
        <h1 className={page.title}>AI connection</h1>
        <p className={page.lede}>The Anthropic API key DI’s agents use. Paste a new key, test it and save it: only a key that works is saved, and DI switches to it straight away. Keys are encrypted and never shown again.</p>
      </header>

      <section className={styles.card} aria-labelledby="ai-now">
        <h2 id="ai-now" className={styles.cardTitle}>
          <PlugZap size={18} aria-hidden /> In use now
        </h2>
        {status.isPending ? (
          <Skeleton height="96px" radius="md" />
        ) : status.isError || !s ? (
          <p className={styles.bad} role="alert">
            <TriangleAlert size={16} aria-hidden /> This page is for DI administrators.
          </p>
        ) : (
          <>
            <dl className={styles.facts}>
              <dt>Key</dt>
              <dd>{s.last4 ? <span className={styles.mono}>sk-ant-…{s.last4}</span> : '—'}</dd>
              <dt>Where it comes from</dt>
              <dd>{SOURCE[s.source]}</dd>
              {s.updatedBy && (
                <>
                  <dt>Set by</dt>
                  <dd>
                    {s.updatedBy}, {when(s.updatedAt)}
                  </dd>
                </>
              )}
              <dt>Live AI</dt>
              <dd>{s.live ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off (offline planner)</Badge>}</dd>
              <dt>Last test</dt>
              <dd>{s.lastTest ? `${s.lastTest.ok ? 'Worked' : 'Failed'}, ${when(s.lastTest.at)}: ${s.lastTest.message}` : 'Not tested yet'}</dd>
            </dl>
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" busy={testCurrent.isPending} disabled={s.source === 'none'} onClick={() => testCurrent.mutate()}>
                Test the connection
              </Button>
            </div>
            {testCurrent.data && <Result r={testCurrent.data} />}
            {testCurrent.error && <Result r={{ ok: false, message: testCurrent.error.message }} />}
          </>
        )}
      </section>

      {s && (
        <form className={styles.card} aria-labelledby="ai-new" onSubmit={onSave} autoComplete="off">
          <h2 id="ai-new" className={styles.cardTitle}>
            <KeyRound size={18} aria-hidden /> Use a new key
          </h2>
          <TextInput
            label="Anthropic API key"
            type="password"
            name="anthropic-key"
            autoComplete="new-password"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            hint="From the Anthropic Console, under API keys. It stays on this page until you save it."
          />
          <div className={styles.actions}>
            <Button type="button" variant="secondary" size="sm" busy={testNew.isPending} disabled={!entered} onClick={() => testNew.mutate(entered)}>
              Test this key
            </Button>
            <Button type="submit" size="sm" busy={save.isPending} disabled={!entered}>
              Save and use it
            </Button>
          </div>
          {testNew.data && <Result r={testNew.data} />}
          {save.data && <Result r={save.data} />}
          {(testNew.error ?? save.error) && <Result r={{ ok: false, message: (testNew.error ?? save.error)!.message }} />}
        </form>
      )}
    </div>
  );
}
