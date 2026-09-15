// 显示当前 Session 下一次根调用预计占用的上下文，并展开本地估算分类。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
import {
  Button,
  Checkbox,
  DropdownMenu,
  Popover,
  ScrollArea,
  Spinner,
  type MenuItem,
} from '@ema-agent/ui';
import type { ContextUsage, ContextUsageCategories } from '@ema-agent/context';
import type { ExecutionProfile } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';
import type { TurnModelSelection } from '@ema-agent/turn';
import { knowledgeApi, type DocumentAsset } from '../../api/knowledge.js';
import {
  findAvailableModel,
  providersApi,
  type AvailableModel,
} from '../../api/providers.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { useLiveTurns } from '../state/liveTurns.js';

type LlmModel = Extract<AvailableModel, { capability: 'llm' }>;

const KB_PAGE_SIZE = 40;

const EFFORT_LABELS: Record<TurnModelSelection['thinkingEffort'], string> = {
  low: '轻度',
  medium: '中',
  high: '高',
  max: '极高',
};

const EXECUTION_PROFILE_LABELS: Record<ExecutionProfile, string> = {
  chat: 'Chat',
  work: 'Work',
};

const EXECUTION_PROFILE_ICONS: Record<ExecutionProfile, string> = {
  chat: 'i-lucide:message-circle',
  work: 'i-lucide:briefcase-business',
};

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: '默认权限',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '绕过权限',
};

/* 菜单第二行解释(安全语义区,光看标题不够):每档说清它实际放行什么。 */
const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: '编辑文件和使用互联网时始终询问',
  acceptEdits: '仅对检测到的风险操作请求批准',
  bypassPermissions: '可不受限制地访问互联网和电脑上的任何文件',
};

export function ExecutionProfileSelector({
  value,
  onChange,
}: {
  value: ExecutionProfile;
  onChange(value: ExecutionProfile): void;
}): JSX.Element {
  const items: MenuItem[] = (['chat', 'work'] as const).map((profile) => ({
    kind: 'item',
    label: EXECUTION_PROFILE_LABELS[profile],
    icon: value === profile
      ? 'i-lucide:check'
      : EXECUTION_PROFILE_ICONS[profile],
    onSelect: () => onChange(profile),
  }));

  return (
    <DropdownMenu
      side="top"
      align="end"
      widthClass="min-w-36"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className="chat-btn"
        >
          {EXECUTION_PROFILE_LABELS[value]}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

export function PermissionModeSelector({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange(value: PermissionMode): void;
}): JSX.Element {
  const items: MenuItem[] = (['default', 'acceptEdits', 'bypassPermissions'] as const).map((mode) => ({
    kind: 'item',
    label: PERMISSION_MODE_LABELS[mode],
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    icon: value === mode ? 'i-lucide:check' : 'i-lucide:circle',
    onSelect: () => onChange(mode),
  }));

  return (
    <DropdownMenu
      side="top"
      align="start"
      widthClass="min-w-64"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className={`chat-btn ${
            value === 'bypassPermissions'
              ? 'text-[var(--ema-warning)]'
              : ''
          }`}
        >
          <span className="i-lucide:shield-check text-sm" aria-hidden />
          {PERMISSION_MODE_LABELS[value]}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

function isLlm(model: AvailableModel): model is LlmModel {
  return model.capability === 'llm';
}

export function ModelPicker({
  selection,
  onChange,
  onClear,
}: {
  selection: TurnModelSelection | null;
  onChange(selection: TurnModelSelection): void;
  onClear(): void;
}): JSX.Element {
  // 模型目录属于当前输入区选择, 直接按需读取本地 API, 不建立跨窗口镜像 Store.
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const loadModels = (): void => {
      const current = ++request;
      void providersApi.listAvailable('llm')
        .then(({ models: available }) => {
          if (!active || current !== request) return;
          setModels([...available]);
          setLoaded(true);
        })
        .catch(() => {
          if (active && current === request) setLoaded(true);
        });
    };

    loadModels();
    const unsubscribe = subscribeSystemEvent((event) => {
      if (event.type !== 'provider_config_changed' && event.type !== 'provider_models_changed') return;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        loadModels();
      }, 150);
    });
    return () => {
      active = false;
      request += 1;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, []);

  const grouped = useMemo(() => {
    const result = new Map<string, LlmModel[]>();
    for (const model of models.filter(isLlm)) {
      const group = result.get(model.providerId) ?? [];
      group.push(model);
      result.set(model.providerId, group);
    }
    return [...result.values()];
  }, [models]);

  const selectedModel = findAvailableModel(
    models,
    selection?.providerId,
    selection?.modelId,
  );
  const label = selectedModel
    ? `${selectedModel.providerId} · ${selectedModel.name ?? selectedModel.modelId}`
    : !loaded
      ? '模型加载中'
      : '默认模型';

  const modelItems: MenuItem[] = grouped.flatMap((group, groupIndex) => [
    ...(groupIndex > 0 ? [{ kind: 'separator' as const }] : []),
    {
      kind: 'item' as const,
      label: group[0]?.providerId ?? 'Provider',
      icon: 'i-lucide:server',
      disabled: true,
      onSelect: () => {},
    },
    ...group.map((model) => ({
      kind: 'item' as const,
      label: model.name ?? model.modelId,
      icon: selection?.providerId === model.providerId
        && selection.modelId === model.modelId
        ? 'i-lucide:check'
        : 'i-lucide:box',
      onSelect: () => onChange({
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingEnabled: model.reasoning === true
          && (selection?.thinkingEnabled ?? false),
        thinkingEffort: selection?.thinkingEffort ?? 'medium',
      }),
    })),
  ]);

  const reasoningAvailable = selection !== null
    && selectedModel?.capability === 'llm'
    && selectedModel.reasoning === true;
  const effortItems: MenuItem[] = [
    {
      kind: 'item',
      label: '无',
      icon: selection?.thinkingEnabled === false
        ? 'i-lucide:check'
        : 'i-lucide:circle',
      disabled: !reasoningAvailable,
      onSelect: () => {
        if (selection) onChange({ ...selection, thinkingEnabled: false });
      },
    },
    ...(['low', 'medium', 'high', 'max'] as const).map((effort) => ({
      kind: 'item' as const,
      label: EFFORT_LABELS[effort],
      icon: selection?.thinkingEnabled && selection.thinkingEffort === effort
        ? 'i-lucide:check'
        : 'i-lucide:circle',
      disabled: !reasoningAvailable,
      onSelect: () => {
        if (selection) {
          onChange({
            ...selection,
            thinkingEnabled: true,
            thinkingEffort: effort,
          });
        }
      },
    })),
  ];

  const items: MenuItem[] = [
    {
      kind: 'submenu',
      label: '模型',
      icon: 'i-lucide:box',
      items: modelItems,
    },
    {
      kind: 'submenu',
      label: '推理强度',
      icon: 'i-lucide:brain',
      items: effortItems,
    },
    ...(selection
      ? [
          { kind: 'separator' as const },
          {
            kind: 'item' as const,
            label: '恢复默认模型',
            icon: 'i-lucide:rotate-ccw',
            onSelect: onClear,
          },
        ]
      : []),
  ];

  const reasoning = !selection?.thinkingEnabled
    ? '无'
    : EFFORT_LABELS[selection.thinkingEffort];

  return (
    <DropdownMenu
      side="top"
      align="end"
      widthClass="min-w-52"
      items={items}
      trigger={(
        <Button
          variant="ghost"
          className="chat-btn min-w-0"
          title={label}
        >
          <span className="max-w-44 truncate">{label}</span>
          {selection && (
            <span className="text-[var(--ema-text-tertiary)]">
              {reasoning}
            </span>
          )}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    />
  );
}

export function KbButton({
  visible,
  selectedIds,
  onChange,
}: {
  visible: boolean;
  selectedIds: readonly string[];
  onChange(ids: readonly string[]): void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DocumentAsset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeKbId = useKnowledgeStore((state) => (
    state.libs.find((library) => library.isActive)?.id
  ));

  const load = useCallback(
    async (cursor?: string) => {
      if (!activeKbId) return;

      setLoading(true);
      try {
        const page = await knowledgeApi.listDocuments(activeKbId, {
          cursor,
          limit: KB_PAGE_SIZE,
        });
        setItems((previous) => (
          cursor ? [...previous, ...page.items] : page.items
        ));
        setNextCursor(page.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [activeKbId],
  );

  useEffect(() => {
    if (open && items.length === 0) void load();
  }, [open, items.length, load]);

  if (!visible) return null;

  const selected = new Set(selectedIds);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      widthClass="w-72"
      trigger={(
        <Button
          variant="ghost"
          className="chat-btn"
        >
          {selectedIds.length > 0 ? `${selectedIds.length} 个文件` : 'KB 全部'}
          <span className="i-lucide:chevron-up text-[10px]" aria-hidden />
        </Button>
      )}
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-[var(--ema-text-secondary)]">
          当前激活知识库
        </span>
        {selectedIds.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>
            使用全部
          </Button>
        )}
      </div>

      <ScrollArea viewportClassName="max-h-52">
        <div className="space-y-0.5 pr-1">
          {items.map((item) => {
            const checked = selected.has(item.id);

            return (
              <button
                type="button"
                key={item.id}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  checked
                    ? 'bg-[var(--ema-primary-muted)]'
                    : 'hover:bg-[var(--ema-surface-2)]'
                }`}
                onClick={() => onChange(
                  checked
                    ? selectedIds.filter((id) => id !== item.id)
                    : [...selectedIds, item.id],
                )}
              >
                <Checkbox
                  checked={checked}
                  className="pointer-events-none"
                  label={item.fileName}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]">
                  {item.fileName}
                </span>
                {item.status !== 'ready' && (
                  <span className="text-[10px] text-[var(--ema-text-tertiary)]">
                    {item.status === 'failed' ? '失败' : '处理中'}
                  </span>
                )}
              </button>
            );
          })}

          {loading && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}
          {!loading && items.length === 0 && (
            <p className="py-4 text-center text-xs text-[var(--ema-text-tertiary)]">
              当前知识库没有文档
            </p>
          )}
        </div>
      </ScrollArea>

      {nextCursor && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          onClick={() => void load(nextCursor)}
        >
          加载更多
        </Button>
      )}
    </Popover>
  );
}

export interface ContextMeterProps {
  readonly sessionId: string | null;
}

interface CategoryRow {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly color: string;
}

const CATEGORY_COLORS = {
  system: 'var(--ema-primary)',
  tools: 'var(--ema-info)',
  skills: 'var(--ema-warning)',
  memory: 'var(--ema-violet)',
  character: 'var(--ema-danger)',
  messages: 'var(--ema-success)',
} as const;

export function ContextMeter({ sessionId }: ContextMeterProps): JSX.Element {
  const entry = useLiveTurns(state => sessionId ? state.contextUsageBySession[sessionId] : undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const inputTokens = entry?.kind === 'llm_call' ? entry.usage.inputTokens : entry?.inputTokens ?? 0;
  const contextWindow = entry?.kind === 'llm_call'
    ? entry.usage.contextWindow
    : entry?.contextWindow ?? 0;
  const ratio = contextWindow > 0 ? Math.min(1, Math.max(0, inputTokens / contextWindow)) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <Popover
      side="top"
      align="end"
      widthClass="w-80"
      trigger={<MeterButton percent={percent} hasUsage={entry !== undefined} />}
    >
      {!entry ? (
        <div className="px-2 py-3 text-sm text-[var(--ema-text-tertiary)]">
          等待当前 Session 的首次模型调用统计。
        </div>
      ) : entry.kind === 'manual_compact' ? (
        <ManualCompactPanel
          inputTokens={entry.inputTokens}
          contextWindow={entry.contextWindow}
          percent={percent}
        />
      ) : (
        <LlmCallPanel
          percent={percent}
          toolsOpen={toolsOpen}
          onToolsOpenChange={setToolsOpen}
          usage={entry.usage}
        />
      )}
    </Popover>
  );
}

function MeterButton({ percent, hasUsage }: { percent: number; hasUsage: boolean }): JSX.Element {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <button
      type="button"
      className="flex size-7 items-center justify-center rounded-full text-[var(--ema-text-tertiary)] transition-colors hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-text-primary)] focus-ring"
      aria-label={hasUsage ? `上下文已使用 ${percent}%` : '上下文用量尚未统计'}
      title={hasUsage ? `Context ${percent}%` : '等待 Context 统计'}
    >
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        {hasUsage && (
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--ema-primary)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        )}
      </svg>
    </button>
  );
}

function ManualCompactPanel(input: {
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly percent: number;
}): JSX.Element {
  return (
    <div className="space-y-3 p-2">
      <UsageHeader
        approximate
        label="压缩后估算"
        inputTokens={input.inputTokens}
        contextWindow={input.contextWindow}
        percent={input.percent}
      />
      <UsageBar percent={input.percent} />
      <p className="text-xs leading-5 text-[var(--ema-text-tertiary)]">
        分类将在下一次根模型调用装配后重新统计。
      </p>
    </div>
  );
}

function LlmCallPanel(input: {
  readonly percent: number;
  readonly toolsOpen: boolean;
  readonly onToolsOpenChange: (open: boolean) => void;
  readonly usage: ContextUsage;
}): JSX.Element {
  const { usage } = input;
  const rows = categoryRows(usage.categories);
  const categoryTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const cacheReadRate = usage.cacheReadInputTokens === undefined || usage.inputTokens <= 0
    ? undefined
    : usage.cacheReadInputTokens / usage.inputTokens;

  return (
    <div className="space-y-3 p-2">
      <UsageHeader
        approximate={usage.source === 'estimate'}
        label="上下文已用"
        inputTokens={usage.inputTokens}
        contextWindow={usage.contextWindow}
        percent={input.percent}
      />
      <CategoryBar rows={rows} total={categoryTotal} />
      <div className="space-y-1">
        {rows.map(row => row.key === 'tools' ? (
          <div key={row.key}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-xs hover:bg-[var(--ema-surface-3)]"
              onClick={() => input.onToolsOpenChange(!input.toolsOpen)}
            >
              <CategoryDot color={row.color} />
              <span>Tools</span>
              <span className={`${input.toolsOpen ? 'i-lucide:chevron-up' : 'i-lucide:chevron-down'} text-[10px] text-[var(--ema-text-tertiary)]`} aria-hidden />
              <EstimatedTokens tokens={row.tokens} />
            </button>
            {input.toolsOpen && (
              <div className="ml-5 border-l border-[var(--ema-border)] pl-3 text-[11px] text-[var(--ema-text-tertiary)]">
                <TokenLine label="内置工具" tokens={usage.categories.tools.systemToolTokens} />
                <TokenLine label="MCP 工具" tokens={usage.categories.tools.mcpToolTokens} />
              </div>
            )}
          </div>
        ) : (
          <div key={row.key} className="flex items-center gap-2 px-1 py-1 text-xs">
            <CategoryDot color={row.color} />
            <span>{row.label}</span>
            <EstimatedTokens tokens={row.tokens} />
          </div>
        ))}
      </div>
      {cacheReadRate !== undefined && (
        <div className="flex items-center justify-between border-t border-[var(--ema-border)] pt-2 text-xs text-[var(--ema-text-tertiary)]">
          <span>缓存读取占比</span>
          <span className="font-mono">{Math.round(cacheReadRate * 100)}%</span>
        </div>
      )}
    </div>
  );
}

function UsageHeader(input: {
  readonly approximate: boolean;
  readonly label: string;
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly percent: number;
}): JSX.Element {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-[var(--ema-text-primary)]">{input.label} {input.percent}%</p>
        <p className="mt-0.5 text-[11px] text-[var(--ema-text-tertiary)]">
          {input.approximate ? '本地估算' : 'Provider 实报'}
        </p>
      </div>
      <span className="font-mono text-xs text-[var(--ema-text-secondary)]">
        {input.approximate ? '~' : ''}{formatTokens(input.inputTokens)} / {formatTokens(input.contextWindow)}
      </span>
    </div>
  );
}

function UsageBar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ema-surface-3)]">
      <div className="h-full rounded-full bg-[var(--ema-primary)]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function CategoryBar({ rows, total }: { rows: readonly CategoryRow[]; total: number }): JSX.Element {
  if (total <= 0) return <UsageBar percent={0} />;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--ema-surface-3)]">
      {rows.filter(row => row.tokens > 0).map(row => (
        <span
          key={row.key}
          className="h-full"
          style={{ width: `${(row.tokens / total) * 100}%`, background: row.color }}
        />
      ))}
    </div>
  );
}

function CategoryDot({ color }: { color: string }): JSX.Element {
  return <span className="size-2 rounded-sm" style={{ background: color }} aria-hidden />;
}

function EstimatedTokens({ tokens }: { tokens: number }): JSX.Element {
  return <span className="ml-auto font-mono text-[var(--ema-text-tertiary)]">~{formatTokens(tokens)}</span>;
}

function TokenLine({ label, tokens }: { label: string; tokens: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span className="font-mono">~{formatTokens(tokens)}</span>
    </div>
  );
}

function categoryRows(categories: ContextUsageCategories): CategoryRow[] {
  return [
    { key: 'system', label: '系统提示词', tokens: categories.systemPromptTokens, color: CATEGORY_COLORS.system },
    { key: 'tools', label: 'Tools', tokens: categories.tools.totalTokens, color: CATEGORY_COLORS.tools },
    { key: 'skills', label: 'Skills', tokens: categories.skillTokens, color: CATEGORY_COLORS.skills },
    { key: 'memory', label: 'Memory', tokens: categories.memoryTokens, color: CATEGORY_COLORS.memory },
    { key: 'character', label: '角色 Prompt', tokens: categories.characterPromptTokens, color: CATEGORY_COLORS.character },
    { key: 'messages', label: 'Messages', tokens: categories.messageTokens, color: CATEGORY_COLORS.messages },
  ];
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    const value = tokens / 1_000;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)}K`;
  }
  const value = tokens / 1_000_000;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}M`;
}
