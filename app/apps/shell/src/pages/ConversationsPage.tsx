// Conversations app (spec 6.6, FE-EXP-040): list, search, rename, archive and delete threads.
// Deleting removes a thread from the list; the audit record of prompts and approvals is kept.
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, MessagesSquare, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react';
import { Button, IconButton, Menu, SegmentedControl, Skeleton, TextInput, useToast } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import page from './Page.module.css';
import styles from './ConversationsPage.module.css';

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)
    : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
};

export function ConversationsPage() {
  const { api } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['threads', q, view],
    queryFn: () => api.threads(q, view === 'archived'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['threads'] });
  const update = useMutation({ mutationFn: (v: { id: string; title?: string; archived?: boolean }) => api.updateThread(v.id, v), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteThread(id),
    onSuccess: () => {
      toast.show('Conversation deleted');
      void invalidate();
    },
  });

  return (
    <div className={`${page.page} ${page.narrow}`}>
      <header className={page.header}>
        <div className={page.headerRow}>
          <h1 className={page.title}>Conversations</h1>
          <Link to="/c/new" className={styles.newLink}>
            New conversation
          </Link>
        </div>
        <div className={styles.filters}>
          <TextInput label="Search conversations" hideLabel placeholder="Search by title" leading={<Search size={14} aria-hidden />} value={q} onChange={(e) => setQ(e.target.value)} className={styles.search} />
          <SegmentedControl
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </div>
      </header>

      {list.isPending ? (
        <div className={styles.list}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="56px" radius="md" />
          ))}
        </div>
      ) : list.data?.length ? (
        <ul className={styles.list}>
          {list.data.map((t) => (
            <li key={t.threadId} className={styles.row}>
              <MessagesSquare size={18} aria-hidden className={styles.icon} />
              {editing === t.threadId ? (
                <form
                  className={styles.rename}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const title = String(new FormData(e.currentTarget).get('title') ?? '').trim();
                    if (title) update.mutate({ id: t.threadId, title });
                    setEditing(null);
                  }}
                >
                  <TextInput label="Conversation title" hideLabel name="title" defaultValue={t.title} ref={(el) => el?.focus()} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                </form>
              ) : (
                <Link to={`/c/${t.threadId}`} className={styles.link}>
                  <span className={styles.title}>{t.title}</span>
                  <span className={styles.meta}>
                    {t.turns} {t.turns === 1 ? 'question' : 'questions'} · {when(t.updatedAt)}
                  </span>
                </Link>
              )}
              {confirmDelete === t.threadId ? (
                <span className={styles.confirm}>
                  <Button size="sm" variant="danger" onClick={() => remove.mutate(t.threadId)}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Menu
                  trigger={<IconButton label={`Actions for ${t.title}`} icon={<MoreHorizontal size={16} aria-hidden />} size="sm" />}
                  items={[
                    { id: 'rename', label: 'Rename', icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(t.threadId) },
                    t.archived
                      ? { id: 'unarchive', label: 'Restore', icon: <ArchiveRestore size={14} aria-hidden />, onSelect: () => update.mutate({ id: t.threadId, archived: false }) }
                      : { id: 'archive', label: 'Archive', icon: <Archive size={14} aria-hidden />, onSelect: () => update.mutate({ id: t.threadId, archived: true }) },
                    { id: 'delete', label: 'Delete', icon: <Trash2 size={14} aria-hidden />, onSelect: () => setConfirmDelete(t.threadId) },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{q ? 'No conversations match that search.' : view === 'archived' ? 'No archived conversations.' : 'No conversations yet. Ask DI something from Home or the bar below.'}</p>
      )}
      <p className={styles.note}>Deleting a conversation removes it from this list. The audit record of what was asked, what the AI did and who approved it is kept, as your institution requires.</p>
    </div>
  );
}
