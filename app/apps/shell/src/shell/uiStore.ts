// Client UI state (spec 11.5): layout regions, the workspace pane, context chips and recent items.
// Memory only: none of this is written to browser storage (FE-ARCH-020).
import { create } from 'zustand';
import type { Block, ContextRef } from '@dinext/block-schemas';

/** A table from the catalog, a block's own rows at full size ("Open grid"), or a member's 360 by token. */
export type WorkspaceView = { kind: 'table'; tableId: string; label: string } | { kind: 'block'; block: Block; label: string } | { kind: 'member'; ref: string; label: string };

export interface RecentItem {
  kind: 'thread' | 'view';
  path: string;
  label: string;
}

interface UiState {
  navExpanded: boolean;
  mobileNavOpen: boolean;
  railOpen: boolean;
  paletteOpen: boolean;
  workspace: WorkspaceView | null;
  /** Workspace width as a percentage of the content area: 30-70, default 40 (spec 6.2). */
  workspaceWidth: number;
  workspaceMaximized: boolean;
  /** Context chips per conversation; "new" is the composer outside a thread (spec 6.7). */
  contexts: Record<string, ContextRef[]>;
  recent: RecentItem[];
  /** Text the palette hands to the conversation bar, e.g. a chosen slash command. */
  prefill: string | null;

  setPrefill: (text: string | null) => void;
  toggleNav: () => void;
  setMobileNav: (open: boolean) => void;
  setRail: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  openWorkspace: (view: WorkspaceView) => void;
  closeWorkspace: () => void;
  setWorkspaceWidth: (pct: number) => void;
  toggleWorkspaceMax: () => void;
  addContext: (key: string, ref: ContextRef) => void;
  removeContext: (key: string, ref: ContextRef) => void;
  moveContext: (from: string, to: string) => void;
  visit: (item: RecentItem) => void;
}

const sameRef = (a: ContextRef, b: ContextRef) => a.type === b.type && a.ref === b.ref;
const clamp = (n: number) => Math.min(70, Math.max(30, Math.round(n)));

export const useUi = create<UiState>((set) => ({
  navExpanded: false,
  mobileNavOpen: false,
  railOpen: false,
  paletteOpen: false,
  workspace: null,
  workspaceWidth: 40,
  workspaceMaximized: false,
  contexts: {},
  recent: [],
  prefill: null,

  setPrefill: (text) => set({ prefill: text }),
  toggleNav: () => set((s) => ({ navExpanded: !s.navExpanded })),
  setMobileNav: (open) => set({ mobileNavOpen: open }),
  setRail: (open) => set({ railOpen: open }),
  setPalette: (open) => set({ paletteOpen: open }),
  openWorkspace: (view) => set({ workspace: view }),
  closeWorkspace: () => set({ workspace: null, workspaceMaximized: false }),
  setWorkspaceWidth: (pct) => set({ workspaceWidth: clamp(pct) }),
  toggleWorkspaceMax: () => set((s) => ({ workspaceMaximized: !s.workspaceMaximized })),
  addContext: (key, ref) =>
    set((s) => {
      const list = s.contexts[key] ?? [];
      return list.some((r) => sameRef(r, ref)) ? s : { contexts: { ...s.contexts, [key]: [...list, ref] } };
    }),
  removeContext: (key, ref) => set((s) => ({ contexts: { ...s.contexts, [key]: (s.contexts[key] ?? []).filter((r) => !sameRef(r, ref)) } })),
  moveContext: (from, to) =>
    set((s) => {
      const moving = s.contexts[from] ?? [];
      const rest = { ...s.contexts, [from]: [] };
      return { contexts: { ...rest, [to]: [...(s.contexts[to] ?? []), ...moving.filter((r) => !(s.contexts[to] ?? []).some((t) => sameRef(t, r)))] } };
    }),
  // The top-bar history keeps ten threads and ten workspace views (FE-EXP-042).
  visit: (item) =>
    set((s) => {
      const rest = s.recent.filter((r) => r.path !== item.path);
      const threads = [item, ...rest].filter((r) => r.kind === 'thread').slice(0, 10);
      const views = [item, ...rest].filter((r) => r.kind === 'view').slice(0, 10);
      return { recent: [item, ...rest].filter((r) => threads.includes(r) || views.includes(r)) };
    }),
}));
