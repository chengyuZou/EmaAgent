import { useState } from 'react';
import { Badge, Button, Card, Dialog, Input, toast } from '@ema-agent/ui';
import { useArtifactStore } from '../stores/artifact-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { Artifact, ArtifactId } from '@ema-agent/contracts';

// ── MIME → file extension ─────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  'text/markdown':     'md',
  'text/html':         'html',
  'text/plain':        'txt',
  'text/csv':          'csv',
  'text/x-python':     'py',
  'text/x-typescript': 'ts',
  'text/x-javascript': 'js',
  'text/x-rust':       'rs',
  'text/x-go':         'go',
  'application/json':  'json',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    'text/markdown':          'Markdown',
    'text/html':              'HTML',
    'text/plain':             '文本',
    'text/csv':               'CSV',
    'text/x-python':          'Python',
    'text/x-typescript':      'TypeScript',
    'text/x-javascript':      'JavaScript',
    'text/x-rust':            'Rust',
    'text/x-go':              'Go',
    'application/json':       'JSON',
    'application/vnd.ema.diff':  'Diff',
    'application/vnd.ema.table': '表格',
    'application/vnd.ema.chart': '图表',
  };
  return map[type] ?? type;
}

function statusBadge(artifact: Artifact): React.JSX.Element {
  if ('appliedAt' in artifact && artifact.appliedAt != null) {
    return <Badge variant="success" dot>已应用</Badge>;
  }
  if ('rejectedAt' in artifact && artifact.rejectedAt != null) {
    return <Badge variant="danger" dot>已拒绝</Badge>;
  }
  return <Badge variant="warn" dot>待处理</Badge>;
}

function isPending(artifact: Artifact): boolean {
  return !('appliedAt' in artifact && artifact.appliedAt != null)
      && !('rejectedAt' in artifact && artifact.rejectedAt != null);
}

function isApplied(artifact: Artifact): boolean {
  return 'appliedAt' in artifact && artifact.appliedAt != null;
}

function buildDefaultPath(root: string | undefined, meta: Record<string, unknown>): string | undefined {
  const filename = typeof meta['filename'] === 'string' ? meta['filename'] : undefined;
  if (!root && !filename) return undefined;
  if (!root) return filename;
  if (!filename) return root;
  // Use forward slash — Tauri dialog accepts it cross-platform
  return `${root}/${filename}`;
}

function buildFilters(type: string): Array<{ name: string; extensions: string[] }> {
  const ext = MIME_TO_EXT[type];
  if (!ext) return [];
  return [{ name: typeLabel(type), extensions: [ext] }];
}

// ── Fallback path dialog (non-Tauri / dev mode) ───────────────────────────────

interface FallbackDialogProps {
  artifactId:   ArtifactId;
  defaultPath?: string;
  onClose():    void;
}

function FallbackDialog({ artifactId, defaultPath, onClose }: FallbackDialogProps): React.JSX.Element {
  const [path, setPath]     = useState(defaultPath ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const applyArtifact = useArtifactStore((s) => s.applyArtifact);

  async function handleSubmit(): Promise<void> {
    if (!path.trim()) { setError('请输入路径'); return; }
    setLoading(true);
    setError(null);
    try {
      await applyArtifact(artifactId, path.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '写入失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="写入工作区"
      description="输入目标文件路径(仅在非 Tauri 环境下显示此输入框)。"
      widthClass="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        <Input
          placeholder="例如：/path/to/file.ts"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          error={error != null}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          autoFocus
        />
        {error && <p className="text-xs text-[var(--ema-danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" loading={loading} onClick={() => void handleSubmit()}>
            写入
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── ArtifactCard ──────────────────────────────────────────────────────────────

export interface ArtifactCardProps {
  artifact: Artifact;
}

export function ArtifactCard({ artifact }: ArtifactCardProps): React.JSX.Element {
  const [applying, setApplying]       = useState(false);
  const [rejecting, setRejecting]     = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);

  const applyArtifact  = useArtifactStore((s) => s.applyArtifact);
  const rejectArtifact = useArtifactStore((s) => s.rejectArtifact);

  const workspaceRoot = useSessionStore(
    (s) => s.sessions.byId.get(artifact.sessionId as string)?.workspaceRoot ?? null,
  );

  // Shared: open Save As dialog → write artifact to chosen path
  async function handlePickAndApply(): Promise<void> {
    if (tauriBridge.isTauri()) {
      const defaultPath = buildDefaultPath(workspaceRoot ?? undefined, artifact.meta);
      const targetPath  = await tauriBridge.saveFileDialog({
        defaultPath,
        filters: buildFilters(artifact.type),
      });
      if (!targetPath) return; // user cancelled
      setApplying(true);
      try {
        await applyArtifact(artifact.id, targetPath);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '应用失败');
      } finally {
        setApplying(false);
      }
    } else {
      setFallbackOpen(true);
    }
  }

  async function handleReject(): Promise<void> {
    setRejecting(true);
    try { await rejectArtifact(artifact.id); } finally { setRejecting(false); }
  }

  const pending = isPending(artifact);
  const applied = isApplied(artifact);

  return (
    <>
      <Card variant="elevated" padding="sm" className="flex flex-col gap-2 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="i-lucide:file-text shrink-0 text-[var(--ema-text-tertiary)]" aria-hidden />
          <span className="truncate text-sm font-medium flex-1 text-[var(--ema-text-primary)]">
            {artifact.title}
          </span>
          <Badge variant="neutral" className="shrink-0 font-mono text-[10px]">
            {typeLabel(artifact.type)}
          </Badge>
          {statusBadge(artifact)}
        </div>

        {/* Actions */}
        {pending && (
          <div className="flex items-center gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              loading={rejecting}
              onClick={() => void handleReject()}
            >
              拒绝
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="i-lucide:folder-open"
              loading={applying}
              onClick={() => void handlePickAndApply()}
            >
              应用到工作区
            </Button>
          </div>
        )}

        {applied && (
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              icon="i-lucide:folder-open"
              loading={applying}
              onClick={() => void handlePickAndApply()}
            >
              重新定位
            </Button>
          </div>
        )}
      </Card>

      {fallbackOpen && (
        <FallbackDialog
          artifactId={artifact.id}
          defaultPath={buildDefaultPath(workspaceRoot ?? undefined, artifact.meta)}
          onClose={() => setFallbackOpen(false)}
        />
      )}
    </>
  );
}
