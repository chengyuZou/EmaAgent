// 只展示当前 Session cwd 对应 Git 仓库的已暂存与未暂存差异。
import { useEffect, useState, type JSX } from 'react';
import { IconButton, Input, Spinner } from '@ema-agent/ui';

import { sessionGitApi, type SessionGitWorkspaceDiff } from '../../../../api/git.js';
import { useSessionStore } from '../../../../stores/session.js';
import { fileTab, useSessionSidePanel } from '../../../state/chatWorkspace.js';
import { DiffCard, type ReviewFileItem } from './DiffCard.js';

type GitDiffFile = Extract<SessionGitWorkspaceDiff, { capability: 'ok' }>['staged']['files'][number];

function reviewFile(file: GitDiffFile, scope: 'staged' | 'unstaged'): ReviewFileItem {
  return {
    key: `${scope}:${file.path}`,
    displayPath: file.path,
    absolutePath: file.status === 'deleted' ? null : file.absolutePath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    unifiedDiff: file.unifiedDiff,
  };
}

export function ReviewPanel({ sessionId }: { sessionId: string }): JSX.Element {
  const cwd = useSessionStore((state) => state.sessions.byId.get(sessionId)?.cwd);
  const openTab = useSessionSidePanel((state) => state.openTab);
  const [result, setResult] = useState<SessionGitWorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [split, setSplit] = useState(false);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setResult(null);
    setRequestError(null);
    void sessionGitApi.workspaceDiff(sessionId)
      .then((next) => {
        if (current) setResult(next);
      })
      .catch((error: unknown) => {
        if (current) setRequestError(error instanceof Error ? error.message : 'Git 差异读取失败');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, [sessionId, cwd, refresh]);

  const git = result?.capability === 'ok' ? result : null;
  const query = filter.trim().toLowerCase();
  const staged = git?.staged.files
    .filter((file) => file.path.toLowerCase().includes(query))
    .map((file) => reviewFile(file, 'staged')) ?? [];
  const unstaged = git?.unstaged.files
    .filter((file) => file.path.toLowerCase().includes(query))
    .map((file) => reviewFile(file, 'unstaged')) ?? [];
  const fileCount = (git?.staged.files.length ?? 0) + (git?.unstaged.files.length ?? 0);
  const omittedCount = (git?.staged.omittedFiles ?? 0) + (git?.unstaged.omittedFiles ?? 0);
  const additions = (git?.staged.totalAdditions ?? 0) + (git?.unstaged.totalAdditions ?? 0);
  const deletions = (git?.staged.totalDeletions ?? 0) + (git?.unstaged.totalDeletions ?? 0);

  let statusMessage: string | null = null;
  if (requestError) statusMessage = requestError;
  else if (result?.capability === 'not-a-repo') statusMessage = '当前 Session 的执行目录不在 Git 仓库中';
  else if (result?.capability === 'git-unavailable') statusMessage = '本机没有可用的 Git';
  else if (result?.capability === 'error') statusMessage = 'Git 差异读取失败';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2 text-xs">
        <span className="font-medium text-[var(--ema-text-primary)]">工作区变更</span>
        {git && (
          <>
            <span className="text-[var(--ema-text-secondary)]">{fileCount} 项变更</span>
            <span className="text-[var(--ema-success-text)]">+{additions}</span>
            <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
          </>
        )}
        <span className="flex-1" />
        {result?.capability !== 'diff-too-large' && (
          <Input
            inputSize="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="筛选文件…"
            className="w-36"
            aria-label="按路径筛选文件"
          />
        )}
        <IconButton size="sm" label="刷新 Git 差异" icon="i-lucide:refresh-cw" onClick={() => setRefresh((value) => value + 1)} />
        {result?.capability !== 'diff-too-large' && (
          <IconButton size="sm" label="分列差异" icon="i-lucide:columns-2" toggled={split} onClick={() => setSplit((value) => !value)} />
        )}
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner size="md" label="正在读取 Git 差异" /></div>
      ) : result?.capability === 'diff-too-large' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="i-lucide:file-warning text-3xl text-[var(--ema-text-tertiary)]" aria-hidden />
          <h2 className="text-sm font-medium text-[var(--ema-text-primary)]">差异过大，暂不展示</h2>
          <p className="max-w-sm text-xs text-[var(--ema-text-secondary)]">
            为保持应用流畅，此处不加载过大的 Git 差异。缩小工作区变更范围后可以刷新重试。
          </p>
        </div>
      ) : statusMessage ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-[var(--ema-text-tertiary)]">{statusMessage}</div>
      ) : fileCount === 0 && omittedCount > 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[var(--ema-text-tertiary)]">有 {omittedCount} 个文件未能读取</div>
      ) : fileCount === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[var(--ema-text-tertiary)]">工作区没有文件变更</div>
      ) : staged.length + unstaged.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-[var(--ema-text-tertiary)]">没有匹配的文件</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {([
            { label: '已暂存', files: staged, omitted: git?.staged.omittedFiles ?? 0 },
            { label: '未暂存', files: unstaged, omitted: git?.unstaged.omittedFiles ?? 0 },
          ] as const).map((section) => section.files.length > 0 && (
            <section key={section.label} className="mb-4">
              <h3 className="mb-1.5 px-1 text-xs font-medium text-[var(--ema-text-secondary)]">
                {section.label} · {section.files.length}
              </h3>
              <div className="flex flex-col gap-1.5">
                {section.files.map((item) => (
                  <DiffCard
                    key={item.key}
                    item={item}
                    expanded={expandedKey === item.key}
                    split={split}
                    onToggle={() => setExpandedKey((current) => current === item.key ? null : item.key)}
                    onOpenFile={(absolutePath) => openTab(sessionId, fileTab(absolutePath))}
                  />
                ))}
              </div>
              {section.omitted > 0 && (
                <p className="px-1 py-2 text-[11px] text-[var(--ema-text-tertiary)]">
                  {section.omitted} 个文件未能读取
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
