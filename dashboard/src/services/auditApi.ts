// dashboard/src/services/auditApi.ts

export type AuditActionType =
  | 'config_change'
  | 'user_create'
  | 'user_update'
  | 'user_delete'
  | 'role_change'
  | 'login'
  | 'logout'
  | 'permission_change'
  | 'data_export'
  | 'system_update'
  | 'other';

export interface AuditActor {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  ipAddress?: string;
}

export interface AuditResource {
  type: string;
  id: string;
  name?: string;
}

export interface AuditRecord {
  id: string;
  actor: AuditActor;
  action: AuditActionType | string;
  actionLabel?: string;
  resource: AuditResource;
  timestamp: string;
  details?: Record<string, unknown>;
  masked?: boolean;
}

export interface AuditQueryParams {
  actionType?: AuditActionType | string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
  actorId?: string;
  resourceType?: string;
}

export interface AuditPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AuditListResponse {
  records: AuditRecord[];
  pagination: AuditPagination;
}

export interface AuditRecordResponse {
  record: AuditRecord;
}

export class AuditApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuditApiError';
    this.status = status;
  }
}

const BASE_URL = '/api/admin/audit';

function buildQueryString(params: AuditQueryParams): string {
  const search = new URLSearchParams();
  if (params.actionType) {
    search.set('actionType', params.actionType);
  }
  if (params.startDate) {
    search.set('startDate', params.startDate);
  }
  if (params.endDate) {
    search.set('endDate', params.endDate);
  }
  if (params.actorId) {
    search.set('actorId', params.actorId);
  }
  if (params.resourceType) {
    search.set('resourceType', params.resourceType);
  }
  if (typeof params.page === 'number') {
    search.set('page', String(params.page));
  }
  if (typeof params.pageSize === 'number') {
    search.set('pageSize', String(params.pageSize));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') {
        message = body.message;
      }
    } catch {
      // ignore parse errors
    }
    throw new AuditApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export async function fetchAuditRecords(
  params: AuditQueryParams = {},
): Promise<AuditListResponse> {
  const url = `${BASE_URL}${buildQueryString(params)}`;
  const data = await request<AuditListResponse>(url, { method: 'GET' });

  const records = Array.isArray(data.records) ? data.records : [];
  const sorted = [...records].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return {
    records: sorted,
    pagination: data.pagination ?? {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? sorted.length,
      total: sorted.length,
      totalPages: 1,
    },
  };
}

export async function fetchAuditRecord(id: string): Promise<AuditRecord> {
  if (!id) {
    throw new AuditApiError('Audit record id is required', 400);
  }
  const url = `${BASE_URL}/${encodeURIComponent(id)}`;
  const data = await request<AuditRecordResponse>(url, { method: 'GET' });
  return data.record;
}

export const auditApi = {
  fetchAuditRecords,
  fetchAuditRecord,
};

export default auditApi;