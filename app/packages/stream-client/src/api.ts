// Experience Layer REST calls used in Slice 0 (spec 12.1, 12.3, 12.5).
import type {
  AppNotification,
  ApprovalDecisionRequest,
  ApprovalErrorCode,
  HomeBriefing,
  ReferralAction,
  ReferralDetail,
  ReferralsIndex,
  PipelineApplicationDetail,
  PipelineIndex,
  PipelineList,
  PipelineViewId,
  DiTake,
  GoalsIndex,
  Member360Block,
  ReportCanvasBlock,
  SearchResult,
  SendMessageRequest,
  Session,
  TableData,
  ThreadSummary,
} from '@dinext/block-schemas';

/** Maps to the spec's error model: callers show permission, conflict and server messages (spec 11.8). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${status} ${path}`);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Access token is held in memory only (FE-ARCH-061). */
  token?: () => string | null;
}

export type DecisionResponse =
  | { ok: true; decision: 'approved' | 'denied' | 'returned'; by: string; at: string }
  | { ok: false; code: ApprovalErrorCode; message?: string };

/** GET /v1/reports: what the Reports app lists (spec 8.5–8.9). */
export interface ReportsIndex {
  take: DiTake;
  templates: { templateId: string; name: string; folder: string; status: 'stock' | 'published' | 'draft'; periodType: 'month' | 'quarter'; description: string; sections: number; owner: string; updatedAt: string; origin?: string }[];
  schedules: { scheduleId: number; templateId: string; report: string; when: string; format: string; recipients: number; owner: string; lastRunAt: string | null; lastResult: 'ok' | 'empty' | 'failed' | null; lastDetail: string | null }[];
}

let counter = 0;
export const newClientMessageId = () => `cm_${Date.now().toString(36)}${(counter++).toString(36)}`;

export function createApiClient({ baseUrl, token }: ApiClientOptions) {
  const headers = (extra: Record<string, string> = {}) => {
    const t = token?.();
    return { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra };
  };

  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, { headers: headers(), signal });
    if (!res.ok) throw new ApiError(res.status, path);
    return (await res.json()) as T;
  };

  const send = async <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new ApiError(res.status, path);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  return {
    async sendMessage(threadId: string, body: SendMessageRequest) {
      const res = await fetch(`${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`send failed: ${res.status}`);
      return (await res.json()) as { messageId: string; runId: string; threadId: string; seq: number };
    },

    async cancelRun(runId: string) {
      await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: headers() });
    },

    /** Approvals go over REST, never the socket, so each decision gets an auditable response. */
    async decide(approvalId: string, body: ApprovalDecisionRequest, idempotencyKey: string): Promise<DecisionResponse> {
      const res = await fetch(`${baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: 'POST',
        headers: headers({ 'idempotency-key': idempotencyKey }),
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { decision?: string; by?: string; at?: string; code?: ApprovalErrorCode; message?: string };
      if (res.ok) return { ok: true, decision: json.decision as 'approved' | 'denied' | 'returned', by: json.by ?? '', at: json.at ?? new Date().toISOString() };
      return { ok: false, code: json.code ?? 'EXPIRED', message: json.message };
    },

    session: (persona?: string) => get<Session>(`/v1/session${persona ? `?persona=${encodeURIComponent(persona)}` : ''}`),
    home: () => get<HomeBriefing>('/v1/home'),
    threads: (q = '', archived = false) => get<{ threads: ThreadSummary[] }>(`/v1/threads?${new URLSearchParams({ q, archived: String(archived) })}`).then((r) => r.threads),
    thread: (threadId: string) => get<ThreadSummary>(`/v1/threads/${encodeURIComponent(threadId)}`),
    createThread: (title?: string) => send<ThreadSummary>('POST', '/v1/threads', { title }),
    updateThread: (threadId: string, patch: { title?: string; archived?: boolean }) => send<ThreadSummary>('PATCH', `/v1/threads/${encodeURIComponent(threadId)}`, patch),
    deleteThread: (threadId: string) => send<void>('DELETE', `/v1/threads/${encodeURIComponent(threadId)}`),
    search: (q: string, signal?: AbortSignal, kind?: 'member') => get<{ results: SearchResult[] }>(`/v1/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`, signal).then((r) => r.results),
    reports: () => get<ReportsIndex>('/v1/reports'),
    goals: () => get<GoalsIndex>('/v1/gi/summary'),
    pipeline: (view?: PipelineViewId) => get<PipelineIndex>(`/v1/lap/summary${view ? `?view=${view}` : ''}`),
    pipelineApplications: (q: { view: PipelineViewId; group?: string; stalled?: boolean }) => get<PipelineList>(`/v1/lap/applications?${new URLSearchParams({ view: q.view, ...(q.group ? { group: q.group } : {}), ...(q.stalled ? { stalled: '1' } : {}) })}`),
    pipelineApplication: (id: number) => get<PipelineApplicationDetail>(`/v1/lap/applications/${id}`),
    referrals: (box: 'mine' | 'team' | 'sent') => get<ReferralsIndex>(`/v1/referrals?box=${box}`),
    referral: (id: number) => get<ReferralDetail>(`/v1/referrals/${id}`),
    referralAction: (id: number, action: ReferralAction) => send<ReferralDetail>('POST', `/v1/referrals/${id}/actions`, action),
    runReport: (templateId: string, controls: Record<string, string> = {}) => send<{ block: ReportCanvasBlock }>('POST', '/v1/reports/run', { templateId, controls }).then((r) => r.block),
    editReport: (templateId: string, op: unknown, controls: Record<string, string>) => send<{ block: ReportCanvasBlock }>('POST', `/v1/reports/${encodeURIComponent(templateId)}/edit`, { op, controls }).then((r) => r.block),
    /** Local stand-in for the after-build trigger: runs every active schedule now. */
    runSchedules: () => send<{ schedules: ReportsIndex['schedules'] }>('POST', '/v1/reports/schedules/run').then((r) => r.schedules),
    /** A member's 360 by opaque token; 404 covers both "not found" and "outside your purview". */
    member: (token: string, signal?: AbortSignal) => get<{ block: Member360Block }>(`/v1/members/${encodeURIComponent(token)}`, signal).then((r) => r.block),
    notifications: () => get<{ notifications: AppNotification[] }>('/v1/notifications').then((r) => r.notifications),
    markNotificationsRead: (ids: string[]) => send<void>('POST', '/v1/notifications/read', { ids }),
    table: (tableId: string) => get<TableData>(`/v1/tables/${encodeURIComponent(tableId)}`),

    async stepUp(): Promise<string | null> {
      const res = await fetch(`${baseUrl}/v1/auth/step-up`, { method: 'POST', headers: headers() });
      if (!res.ok) return null;
      return ((await res.json()) as { stepUpToken: string }).stepUpToken;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
