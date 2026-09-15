// 输入区添加菜单:确定性命令与启用 Skill 共用搜索浮层和键盘导航.
// 合并选择浮层。锚定 composer 上沿（ui 包 Popover，side=top）；过滤词来自输入框
// 的斜杠 token；键盘经 handleRef 由 textarea 转发：↑↓ 移动、Enter 选中、Esc 关闭。
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { Popover } from '@ema-agent/ui';
import { commandsApi, type CommandDescriptor } from '../../api/commands.js';
import { skillsApi, type SkillListItem } from '../../api/skills.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';

interface LocalCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly icon: string;
}

const LOCAL_COMMANDS: readonly LocalCommandDescriptor[] = [
  { name: 'new', description: '新建聊天', icon: 'i-lucide:plus' },
  { name: 'fork', description: '创建当前聊天的分支', icon: 'i-lucide:git-fork' },
  { name: 'rename', description: '重命名当前聊天', icon: 'i-lucide:pencil' },
  { name: 'pin', description: '置顶或取消置顶当前聊天', icon: 'i-lucide:pin' },
  { name: 'archive', description: '归档当前聊天', icon: 'i-lucide:archive' },
];

export interface SlashToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** 未闭合的斜杠 token 只能位于整段文字开头或当前输入末尾. */
export function activeSlashToken(
  text: string,
  caret = text.length,
): SlashToken | null {
  if (caret < 0 || caret > text.length) return null;

  const beforeCaret = text.slice(0, caret);
  const slash = beforeCaret.lastIndexOf('/');
  if (slash < 0) return null;

  const token = beforeCaret.slice(slash + 1);
  if (/\s/.test(token)) return null;

  const atStart = slash === 0;
  const atEnd = caret === text.length
    && (slash === 0 || /\s/.test(text[slash - 1] ?? ''));
  if (!atStart && !atEnd) return null;

  return {
    start: slash,
    end: caret,
    query: token,
  };
}

function matchesSlashQuery(name: string, query: string): boolean {
  if (query === '') return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

function skillOrigin(skill: SkillListItem): string {
  if (skill.scope === 'builtin') return '系统';
  if (skill.scope === 'user') return '个人';
  const folderPath = skill.sourceFolderPath ?? '';
  const parts = folderPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? folderPath;
}

export type SlashSelection =
  | { kind: 'command'; command: CommandDescriptor }
  | { kind: 'skill'; skill: SkillListItem };

/** 键盘转发出口：返回 true 表示该键已被菜单消费（调用方 preventDefault）。 */
export interface SlashMenuHandle {
  handleKey(key: 'ArrowUp' | 'ArrowDown' | 'Enter'): boolean;
}

interface FlatItem {
  key: string;
  selection: SlashSelection;
  section: string;
  icon: string;
  title: string;
  detail: string;
  origin?: string;
}

export interface SlashCommandMenuProps {
  /** 非 null 时菜单打开；值为当前过滤词。 */
  query: string | null;
  /** 依附的 Session（Skill 目录按它合成 project 作用域）。 */
  sessionId: string | null;
  projectId: string | null;
  handleRef: RefObject<SlashMenuHandle | null>;
  onSelect(selection: SlashSelection): void;
  onClose(): void;
}

export function SlashCommandMenu({
  query,
  sessionId,
  projectId,
  handleRef,
  onSelect,
  onClose,
}: SlashCommandMenuProps): JSX.Element | null {
  const [commands, setCommands] = useState<readonly CommandDescriptor[]>([]);
  const [skills, setSkills] = useState<readonly SkillListItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const open = query !== null;
  const filter = query ?? '';

  // 命令目录全局稳定，打开时读取一次。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void commandsApi.list()
      .then((catalog) => { if (!disposed) setCommands(catalog.commands); })
      .catch(() => { if (!disposed) setCommands([]); });
    return () => { disposed = true; };
  }, [open]);

  // 技能目录跟随 Session/Project；设置窗口改动技能时重读当前目录。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let requestId = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const selectedProjectId = sessionId ? undefined : projectId ?? undefined;
    const refresh = () => {
      const currentRequestId = ++requestId;
      void skillsApi.list(sessionId ?? undefined, selectedProjectId)
        .then((result) => {
          if (!disposed && currentRequestId === requestId) setSkills(result.items);
        })
        .catch(() => {
          if (!disposed && currentRequestId === requestId) setSkills([]);
        });
    };
    refresh();
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type !== 'skills_changed') return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 150);
    });
    return () => {
      disposed = true;
      unsubscribe();
      clearTimeout(refreshTimer);
    };
  }, [open, sessionId, projectId]);

  const items = useMemo<FlatItem[]>(() => {
    // 后端目录（确定性命令）在前，本地命令随后；同名去重（后端优先）。
    const catalogNames = new Set(commands.map((command) => command.name));
    const commandItems: FlatItem[] = [
      ...commands
        .filter((command) => matchesSlashQuery(command.name, filter))
        .map((command) => ({
          key: `command:${command.name}`,
          selection: { kind: 'command', command } as SlashSelection,
          section: '命令',
          icon: 'i-lucide:terminal',
          title: `/${command.name}`,
          detail: command.description,
        })),
      ...LOCAL_COMMANDS
        .filter((local) => !catalogNames.has(local.name))
        .filter((local) => matchesSlashQuery(local.name, filter))
        .map((local) => ({
          key: `command:${local.name}`,
          selection: {
            kind: 'command',
            command: { name: local.name, description: local.description },
          } as SlashSelection,
          section: '命令',
          icon: local.icon,
          title: `/${local.name}`,
          detail: local.description,
        })),
    ];
    const skillItems: FlatItem[] = skills
      .filter((skill) => skill.enabled)
      .filter((skill) => matchesSlashQuery(skill.name, filter))
      .map((skill) => ({
        key: `skill:${skill.path}`,
        selection: { kind: 'skill', skill },
        section: '技能',
        icon: 'i-lucide:sparkles',
        title: `/${skill.name}`,
        detail: skill.description,
        origin: skillOrigin(skill),
      }));
    return [...commandItems, ...skillItems];
  }, [commands, skills, filter]);

  // 过滤词或条目数变化时回到首项。
  useEffect(() => {
    setActiveIndex(0);
  }, [filter, items.length]);

  useImperativeHandle(handleRef, () => ({
    handleKey(key) {
      if (!open) return false;
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (items.length === 0) return true;
        const direction = key === 'ArrowUp' ? -1 : 1;
        setActiveIndex((current) => (current + direction + items.length) % items.length);
        return true;
      }
      // Enter：有激活项即选中；空列表消费掉免得误发送一个裸 '/xxx'。
      const active = items[activeIndex];
      if (active) onSelect(active.selection);
      return true;
    },
  }), [open, items, activeIndex, onSelect]);

  // 激活项滚进可视区。
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <Popover
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      side="top"
      align="start"
      sideOffset={4}
      widthClass=""
      style={{ width: 'var(--radix-popover-trigger-width)' }}
      trigger={<span className="absolute inset-x-0 top-0 h-0 pointer-events-none" aria-hidden />}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div className="max-h-72 overflow-y-auto">
        <div ref={listRef} className="flex flex-col gap-0.5">
          {items.length === 0 && (
            <div className="px-2 py-3 text-xs text-center text-[var(--ema-text-tertiary)]">
              没有匹配的命令或技能
            </div>
          )}
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              data-index={index}
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                index === activeIndex
                  ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]'
                  : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(item.selection)}
            >
              <span className={`${item.icon} text-sm shrink-0 text-[var(--ema-text-tertiary)]`} aria-hidden />
              <span className="text-xs font-mono shrink-0">{item.title}</span>
              <span className="min-w-0 flex-1 text-xs truncate text-[var(--ema-text-tertiary)]">{item.detail}</span>
              <span className="ml-auto text-[10px] shrink-0 text-[var(--ema-text-tertiary)]">
                {item.origin ?? (index === 0 || items[index - 1]!.section !== item.section ? item.section : '')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
