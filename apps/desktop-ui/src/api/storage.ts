import { sidecarClient } from './sidecar-client.js';
import type { SessionId } from '@ema-agent/ids';
import type { SessionDashboardWire, SessionNoteWire } from '@ema-agent/session';

// ── DataDir wire types ────────────────────────────────────────────────────────

export interface DataDirItem {
  name:        string;
  path:        string;
  isActive:    boolean;
  addedAt:     number;
  dataDbBytes: number;
}

export interface DataDirListResult {
  active: string;
  dirs:   DataDirItem[];
}

export interface StorageStatsWire {
  path:            string;
  sessionCount:    number;
  turnCount:       number;
  messageCount:    number;
  agentRunCount:   number;
  audioCount:      number;
  audioDurationMs: number;
  dataDbBytes:     number;
  audioBytes:      number;
  sessionsBytes:   number;
  totalBytes:      number;
}

export type { SessionDashboardWire, SessionNoteWire };

// ── API object ────────────────────────────────────────────────────────────────

export const storageApi = {
  // ── DataDir management ───────────────────────────────────────────────────

  /** GET /api/storage — list all registered DataDirs. */
  async listDirs(): Promise<DataDirListResult> {
    return sidecarClient.request<DataDirListResult>('/api/storage');
  },

  /** POST /api/storage — register a new DataDir. */
  async addDir(opts: { name: string; path: string }): Promise<DataDirItem> {
    return sidecarClient.request<DataDirItem>('/api/storage', {
      method: 'POST',
      json: opts,
    });
  },

  /** DELETE /api/storage/:name — unregister (no disk deletion). */
  async removeDir(name: string): Promise<void> {
    await sidecarClient.request(`/api/storage/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  /** POST /api/storage/:name/activate — switch active DataDir (restart required). */
  async activateDir(name: string): Promise<{ ok: boolean; restartRequired: boolean }> {
    return sidecarClient.request(`/api/storage/${encodeURIComponent(name)}/activate`, {
      method: 'POST',
    });
  },

  /** GET /api/storage/stats — aggregate stats for the active DataDir. */
  async getStats(): Promise<StorageStatsWire> {
    return sidecarClient.request<StorageStatsWire>('/api/storage/stats');
  },

  /** POST /api/storage/migrate — hot-copy active dir to a new path, then register + activate. */
  async migrate(opts: {
    name:       string;
    targetPath: string;
  }): Promise<{ ok: boolean; restartRequired: boolean; targetPath: string }> {
    return sidecarClient.request('/api/storage/migrate', {
      method: 'POST',
      json: opts,
    });
  },

  // ── Session detail — lives at /api/storage/sessions/* ───────────────────

  /** GET /api/storage/sessions/:id/dashboard */
  async getDashboard(id: SessionId): Promise<SessionDashboardWire> {
    return sidecarClient.request<SessionDashboardWire>(`/api/storage/sessions/${id}/dashboard`);
  },

  /** GET /api/storage/sessions/:id/notes */
  async getNotes(id: SessionId): Promise<SessionNoteWire | null> {
    return sidecarClient.request<SessionNoteWire | null>(`/api/storage/sessions/${id}/notes`);
  },

  /** POST /api/storage/sessions/:id/export — download session as ZIP Blob with server filename. */
  async exportSession(id: SessionId): Promise<{ blob: Blob; filename: string | null }> {
    const res = await sidecarClient.requestRaw(`/api/storage/sessions/${id}/export`, { method: 'POST' });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return { blob: await res.blob(), filename: contentDispositionFilename(res) };
  },

  /** POST /api/storage/sessions/import — upload a ZIP and restore the session. */
  async importSession(file: File): Promise<{
    session: { id: string; title: string };
    warnings: string[];
  }> {
    const form = new FormData();
    form.append('file', file);
    const res = await sidecarClient.requestRaw('/api/storage/sessions/import', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
      const mapped = body?.error ? IMPORT_ERROR_MESSAGES[body.error] : undefined;
      throw new Error(mapped ?? body?.message ?? `导入失败 (${res.status})`);
    }
    return res.json() as Promise<{ session: { id: string; title: string }; warnings: string[] }>;
  },
};

/** 导入错误码 → 中文业务文案;message 兜底保留后端说明。 */
const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  unsupported_version: '这是旧版备份格式,请用当前版本重新导出后再导入',
  integrity_mismatch: '备份文件已损坏或被修改,完整性校验未通过',
  restore_failed: '恢复数据时出错,请重试;若持续失败请反馈开发者',
  destination_conflict: '该会话已存在,请先删除后再导入',
  archive_too_large: '备份文件超过大小限制',
  entry_too_large: '备份内容超过大小限制',
  expanded_size_too_large: '备份解压后超过大小限制',
  too_many_entries: '备份文件条目数超过限制',
  compression_ratio_too_high: '备份文件异常:压缩比过高',
  invalid_zip: '不是有效的 ZIP 备份文件',
  invalid_format: '备份内容格式不正确',
  unsupported_content: '备份包含当前版本不支持的内容',
  unsafe_archive_path: '备份包含不安全的路径,已拒绝导入',
  import_cancelled: '导入已取消',
};

/** RFC 5987 filename*=UTF-8''<encoded> 解析,拿不到返回 null。 */
function contentDispositionFilename(res: Response): string | null {
  const header = res.headers.get('content-disposition');
  if (!header) return null;
  const match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
