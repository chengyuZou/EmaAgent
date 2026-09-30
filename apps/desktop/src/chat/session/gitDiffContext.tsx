// 当前 Session 的顶部和审查共享全部未提交差异, 不建立全局查询缓存.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { BuiltinTools } from '@ema-agent/tools/identity';
import {
  sessionGitApi,
  type GitDiffScope,
  type SessionGitWorkspaceDiff,
} from '../../api/git.js';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import { useSessionStore } from '../../stores/session.js';
import { useSessionPanelStore } from '../../stores/sessionPanel.js';

const WORKSPACE_WRITE_TOOL_NAMES = new Set<string>([
  BuiltinTools.FileEdit.name,
  BuiltinTools.FileWrite.name,
  BuiltinTools.Bash.name,
  BuiltinTools.PowerShell.name,
]);

interface GitDiffData {
  result: SessionGitWorkspaceDiff;
  files: FileDiffMetadata[];
  additions: number;
  deletions: number;
}

interface GitDiffRead {
  data: GitDiffData | null;
  loading: boolean;
  error: string | null;
}

interface GitDiffReadState extends GitDiffRead {
  sessionId: string;
  cwd: string | null | undefined;
  scope: GitDiffScope;
}

const EMPTY_GIT_READ: GitDiffRead = { data: null, loading: false, error: null };

interface SessionGitDiff {
  sessionId: string;
  cwd: string | null | undefined;
  uncommitted: GitDiffRead;
  reviewScope: GitDiffScope;
  setReviewScope: (scope: GitDiffScope) => void;
  summaryOpen: boolean;
  setSummaryOpen: (open: boolean) => void;
  reviewOpen: boolean;
  revision: number;
  refresh: () => void;
}

const GitDiffContext = createContext<SessionGitDiff | null>(null);

export function SessionGitDiffProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}): JSX.Element {
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd);
  const reviewOpen = useSessionPanelStore(state => {
    const layout = state.layouts[sessionId];
    return layout?.open === true && layout.activeTabId === 'review';
  });
  const [reviewScope, setReviewScope] = useState<GitDiffScope>('uncommitted');
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const uncommitted = useWorkspaceDiffRead(
    sessionId,
    cwd,
    'uncommitted',
    revision,
    summaryOpen || (reviewOpen && reviewScope === 'uncommitted'),
  );
  useToolDiffRefresh(sessionId, cwd, summaryOpen || reviewOpen, refresh);
  const value = useMemo<SessionGitDiff>(() => ({
    sessionId,
    cwd,
    uncommitted,
    reviewScope,
    setReviewScope,
    summaryOpen,
    setSummaryOpen,
    reviewOpen,
    revision,
    refresh,
  }), [sessionId, cwd, uncommitted, reviewScope, summaryOpen, reviewOpen, revision, refresh]);
  return <GitDiffContext.Provider value={value}>{children}</GitDiffContext.Provider>;
}

export function useSessionGitDiff(): SessionGitDiff {
  const value = useContext(GitDiffContext);
  if (!value) {
    throw new Error('Session Git diff must be read inside SessionGitDiffProvider');
  }
  return value;
}

export function useReviewGitDiff(scope: GitDiffScope): GitDiffRead {
  const shared = useSessionGitDiff();
  const selected = useWorkspaceDiffRead(
    shared.sessionId,
    shared.cwd,
    scope,
    shared.revision,
    shared.reviewOpen && scope !== 'uncommitted',
  );
  return scope === 'uncommitted' ? shared.uncommitted : selected;
}

function useWorkspaceDiffRead(
  sessionId: string,
  cwd: string | null | undefined,
  scope: GitDiffScope,
  revision: number,
  enabled: boolean,
): GitDiffRead {
  const [read, setRead] = useState<GitDiffReadState | null>(null);
  const accepted = useRef<GitDiffReadState | null>(null);
  const patchRevision = useRef(0);
  const instanceId = useId();
  useEffect(() => {
    const previous = accepted.current;
    if (previous?.sessionId !== sessionId || previous.cwd !== cwd || previous.scope !== scope) {
      accepted.current = null;
    }
    if (!enabled) {
      setRead(accepted.current);
      return;
    }
    const controller = new AbortController();
    setRead({ sessionId, cwd, scope, data: accepted.current?.data ?? null, loading: true, error: null });
    void sessionGitApi.workspaceDiff(sessionId, scope, controller.signal)
      .then(result => {
        if (controller.signal.aborted) {
          return;
        }
        const previousData = accepted.current?.data;
        let data: GitDiffData;
        if (result.capability !== 'ok') {
          data = { result, files: [], additions: 0, deletions: 0 };
        } else if (previousData?.result.capability === 'ok' && previousData.result.patch === result.patch) {
          data = { ...previousData, result };
        } else {
          const prefix = `${instanceId}:${++patchRevision.current}`;
          const files = parsePatchFiles(result.patch, prefix, true).flatMap(patch => patch.files);
          let additions = 0;
          let deletions = 0;
          for (const file of files) {
            for (const hunk of file.hunks) {
              additions += hunk.additionLines;
              deletions += hunk.deletionLines;
            }
          }
          data = { result, files, additions, deletions };
        }
        accepted.current = { sessionId, cwd, scope, data, loading: false, error: null };
        setRead(accepted.current);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRead(previous => ({
            ...previous,
            sessionId,
            cwd,
            scope,
            data: previous?.data ?? null,
            loading: false,
            error: error instanceof Error ? error.message : 'Git 差异读取失败',
          }));
        }
      });
    return () => controller.abort();
  }, [sessionId, cwd, scope, revision, enabled, instanceId]);
  // 路径或范围刚变化时, effect 尚未清理旧请求, 消费方也不能先显示旧结果.
  if (read?.sessionId !== sessionId || read.cwd !== cwd || read.scope !== scope) {
    return EMPTY_GIT_READ;
  }
  return read;
}

function useToolDiffRefresh(
  sessionId: string,
  cwd: string | null | undefined,
  enabled: boolean,
  refresh: () => void,
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = sessionWebSocket.subscribe(sessionId, {
      onMessage(message) {
        let name: string;
        if (message.type === 'turn_event' && message.event.type === 'tool_result') {
          name = message.event.name;
        } else if (message.type === 'subagent_event' && message.event.type === 'tool_result') {
          name = message.event.toolName;
        } else {
          return;
        }
        if (!WORKSPACE_WRITE_TOOL_NAMES.has(name)) {
          return;
        }
        // 执行失败也可能已经改了文件; 多个工具短时间结束只触发一次读取.
        clearTimeout(timer);
        timer = setTimeout(refresh, 150);
      },
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [sessionId, cwd, enabled, refresh]);
}
