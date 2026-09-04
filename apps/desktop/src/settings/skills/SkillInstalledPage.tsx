// 已安装技能子页:搜索过滤 + 卡片网格(启停/卸载) + 详情弹窗(SKILL.md 文档 + 目录文件)。
// 视觉与市场卡同语言;真扫刷新在页头。
import { useMemo, useState, type JSX } from 'react';
import {
  Badge, Button, Callout, Dialog, EmptyState, IconButton, Input, Spinner, Switch, Tooltip,
} from '@ema-agent/ui';
import { useSkillStore } from '../../stores/skill.js';
import { skillsApi, type SkillListItem } from '../../api/skills.js';
import { showToast } from '../../lib/toast.js';
import { Markdown } from '../../markdown/renderer.js';

const SCOPE_LABEL: Record<string, string> = {
  builtin: '内置',
  user:    '用户',
  project: '项目',
};

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillInstalledPage(): JSX.Element {
  const skills  = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error   = useSkillStore((s) => s.error);

  const [q, setQ] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<SkillListItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [detail, setDetail] = useState<SkillListItem | null>(null);

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    if (!keyword) return skills;
    return skills.filter((sk) =>
      sk.name.toLowerCase().includes(keyword)
      || sk.description.toLowerCase().includes(keyword)
      || sk.path.toLowerCase().includes(keyword),
    );
  }, [skills, q]);

  async function rescan(): Promise<void> {
    setRescanning(true);
    try {
      await useSkillStore.getState().rescan();
      showToast('技能目录已重新扫描', { variant: 'success' });
    } catch (err) {
      showToast(`扫描失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setRescanning(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const path = pendingRemove.path;
    setRemoving(true);
    try {
      await useSkillStore.getState().remove(path);
      showToast(`已卸载 ${pendingRemove.name}`, { variant: 'success' });
      setPendingRemove(null);
      if (detail?.path === path) setDetail(null);
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">已安装</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            内置与用户技能；启停下一根对话 Turn 生效。去「技能市场」安装新技能。
          </p>
        </div>
        <IconButton
          icon="i-lucide:refresh-cw"
          label="重新扫描技能目录"
          loading={rescanning}
          onClick={() => void rescan()}
        />
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <div className="shrink-0">
        <Input
          placeholder="搜索已安装技能…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading && skills.length === 0 ? (
        <div className="flex justify-center py-16"><Spinner size="md" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="i-mdi:puzzle-outline"
          title={skills.length === 0 ? '暂无已安装技能' : '没有匹配的技能'}
          hint={skills.length === 0 ? '到左侧「技能市场」浏览安装' : '换个关键词'}
          className="py-16"
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-2">
          {filtered.map((sk, i) => (
            <div
              key={sk.path}
              className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--diamond bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] px-4 py-3"
              style={{ '--stagger-i': i } as React.CSSProperties}
            >
              <div className="flex items-start gap-3">
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setDetail(sk)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* 启停状态点:实心=启用,空心环=禁用 */}
                    <span
                      className={`size-2.5 rounded-full shrink-0 ${sk.enabled
                        ? 'bg-[var(--ema-success)]'
                        : 'border-2 border-solid border-[var(--ema-border-strong)] bg-transparent'}`}
                      aria-hidden
                    />
                    <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{sk.name}</span>
                    <Badge variant="neutral">v{sk.version}</Badge>
                    <Badge variant="neutral">{SCOPE_LABEL[sk.scope] ?? sk.scope}</Badge>
                  </div>
                  {sk.description && (
                    <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{sk.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
                    {formatBytes(sk.sizeBytes) && <span>{formatBytes(sk.sizeBytes)}</span>}
                    <span className="font-mono truncate opacity-60">{sk.path}</span>
                  </div>
                </button>
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                  <Tooltip content={sk.enabled ? '禁用技能' : '启用技能'}>
                    <Switch
                      checked={sk.enabled}
                      label={sk.name}
                      onCheckedChange={(checked) => {
                        void useSkillStore.getState()
                          .setEnabled(sk.path, checked)
                          .catch((err: Error) => showToast(`更新失败: ${err.message}`, { variant: 'danger' }));
                      }}
                    />
                  </Tooltip>
                  {sk.scope === 'user' && (
                    <Tooltip content="卸载技能">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
                        onClick={() => setPendingRemove(sk)}
                      >
                        <span className="i-mdi:delete-outline text-base" aria-hidden />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillDetailDialog skill={detail} onClose={() => setDetail(null)} onRemove={(sk) => { setDetail(null); setPendingRemove(sk); }} />

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => { if (!open) setPendingRemove(null); }}
        title={pendingRemove ? `卸载 ${pendingRemove.name}?` : ''}
        widthClass="max-w-md"
      >
        {pendingRemove && (
          <div className="flex flex-col gap-3">
            <Callout variant="danger" className="text-xs">
              将删除本地目录与索引。市场安装的技能卸载后可随时回市场重装。
            </Callout>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingRemove(null)}>取消</Button>
              <Button variant="danger" size="sm" loading={removing} onClick={() => void confirmRemove()}>卸载</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function SkillDetailDialog(props: {
  skill: SkillListItem | null;
  onClose(): void;
  onRemove(skill: SkillListItem): void;
}): JSX.Element {
  const { skill, onClose, onRemove } = props;
  const [tab, setTab] = useState<'doc' | 'files'>('doc');
  const [content, setContent] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null);
  const [fileView, setFileView] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // 打开详情时一次性取文档与文件清单;切换技能或关闭时复位。
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (skill && skill.path !== loadedKey) {
    setLoadedKey(skill.path);
    setTab('doc');
    setContent(null);
    setFiles(null);
    setFileView(null);
    setBusy(true);
    void Promise.all([
      skillsApi.getContent(skill.path).then(res => setContent(res.content)),
      skillsApi.listFiles(skill.path).then(res => setFiles(res.items)),
    ])
      .catch((err: unknown) => showToast(`详情加载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' }))
      .finally(() => setBusy(false));
  }
  if (!skill && loadedKey !== null) setLoadedKey(null);

  async function openFile(path: string): Promise<void> {
    if (!skill) return;
    setBusy(true);
    try {
      const result = await skillsApi.readFile(skill.path, path);
      setFileView({ path, content: result.content, truncated: result.truncated });
    } catch (err) {
      showToast(`文件读取失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={skill !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={skill ? skill.name : ''}
      widthClass="max-w-3xl"
    >
      {skill && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--ema-text-tertiary)]">
            <Badge variant="neutral">v{skill.version}</Badge>
            <Badge variant="neutral">{SCOPE_LABEL[skill.scope] ?? skill.scope}</Badge>
            <Badge variant={skill.enabled ? 'success' : 'neutral'}>{skill.enabled ? '已启用' : '已禁用'}</Badge>
            {formatBytes(skill.sizeBytes) && <span>{formatBytes(skill.sizeBytes)}</span>}
            <span className="font-mono opacity-60">{skill.path}</span>
          </div>

          <div className="flex gap-2 border-b border-[var(--ema-border)]">
            {(['doc', 'files'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setFileView(null); }}
                className={`px-3 py-1.5 text-xs transition-colors ${tab === key
                  ? 'text-[var(--ema-primary)] border-b-2 border-[var(--ema-primary)]'
                  : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]'}`}
              >
                {key === 'doc' ? '文档' : `文件${files ? ` (${files.length})` : ''}`}
              </button>
            ))}
          </div>

          {busy && content === null && files === null ? (
            <div className="flex justify-center py-12"><Spinner size="md" /></div>
          ) : tab === 'doc' ? (
            <div className="max-h-[46vh] overflow-auto rounded-lg p-3 bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
              <Markdown source={content ?? '（读取失败）'} />
            </div>
          ) : (
            <div className="max-h-[46vh] overflow-auto rounded-lg bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
              {fileView ? (
                <div>
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--ema-border)]">
                    <span className="font-mono text-xs text-[var(--ema-text-secondary)]">{fileView.path}</span>
                    <Button variant="ghost" size="sm" onClick={() => setFileView(null)}>返回</Button>
                  </div>
                  <pre className="p-3 text-[11px] font-mono whitespace-pre-wrap break-all text-[var(--ema-text-secondary)]">
                    {fileView.content}
                    {fileView.truncated && '\n…(内容过大已截断)'}
                  </pre>
                </div>
              ) : (
                <div className="flex flex-col">
                  {(files ?? []).map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => void openFile(file.path)}
                      className="flex items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--ema-surface-2)] transition-colors"
                    >
                      <span className="font-mono text-[var(--ema-text-secondary)]">{file.path}</span>
                      <span className="text-[var(--ema-text-tertiary)]">{formatBytes(file.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {skill.scope === 'user' && (
            <div className="flex justify-end">
              <Button variant="danger" size="sm" onClick={() => onRemove(skill)}>卸载</Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
