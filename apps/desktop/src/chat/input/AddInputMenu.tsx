// 展示斜杠菜单并把选中结果交给 ChatInput; 菜单本身不发送消息或执行命令.
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
  /** `/` 在整段输入中的下标 */
  readonly start: number;
  /** 这个 `/词` 的末尾下标, 用于整体删除
   * 注意 end 和光标位置不一定相同：光标可能停在词中间
   * (如 /comp|act), 但删除时要删掉整个 /compact
  */
  readonly end: number;
  /** `/` 与光标之间的文字，用来过滤菜单. */
  readonly query: string;
}

/** 判断光标当前是否正处在一个 `/搜索词` 里
 * 如果是, 就返回这个词的范围和查询内容
 * 供上层弹出 `/` 过滤命令菜单用。
*/
export function activeSlashToken(
  text: string,
  // 默认光标在末尾
  caret = text.length,
): SlashToken | null {
  if (caret < 0 || caret > text.length) return null;

  // 从光标往前找最后一个 `/`
  const beforeCaret = text.slice(0, caret);
  const slash = beforeCaret.lastIndexOf('/');
  if (slash < 0) return null;

  // 取出 `/` 到光标之间的内容作为 query
  const token = beforeCaret.slice(slash + 1);
  // 如果 `/` 和光标之间出现了空白(空格、换行等), 说明这个 `/` 是普通文本的一部分(比如 1/2 3), 不是命令, 直接放弃.
  if (/\s/.test(token)) return null;

  const atStart = slash === 0;
  const atEnd = caret === text.length
    && (slash === 0 || /\s/.test(text[slash - 1] ?? ''));
  if (!atStart && !atEnd) return null;

  const suffix = text.slice(caret).match(/^[^\s]*/)?.[0] ?? '';
  return {
    start: slash,
    end: caret + suffix.length,
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

/** Textarea 保持焦点, ChatInput 把方向键和 Enter 交给菜单; true 表示不再按输入框按键处理. */
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
  /** 非 null 时菜单打开, 值为当前斜杠后的过滤词. */
  query: string | null;
  /** 已有 Session 才有当前这批命令; 技能目录也用它查找 Session 所属项目. */
  sessionId: string | null;
  /** 新对话尚无 Session 时, 按选中项目读取技能. */
  projectId: string | null;
  /** ChatInput 看完整份草稿后给出的命令展示条件; Skill 不受此条件限制. */
  showCommands: boolean;
  /** 当前 Session 忙于 Turn 或手动压缩时, 不显示 /compact. */
  compactAvailable: boolean;
  /** ChatInput 用它将 textarea 按键交给菜单, 菜单不抢输入焦点. */
  handleRef: RefObject<SlashMenuHandle | null>;
  /** 用户点击条目或按 Enter 选中高亮项时调用; ChatInput 插入技能引用或执行命令, 不发送用户消息. */
  onSelect(selection: SlashSelection): void;
  /** 点击菜单外时关闭菜单; 草稿仍由 ChatInput 保留. */
  onClose(): void;
}

export function SlashCommandMenu({
  query,
  sessionId,
  projectId,
  showCommands,
  compactAvailable,
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

  // 新对话不显示命令, 也不需要读取后端命令目录.
  useEffect(() => {
    if (!open || !showCommands) return;
    let disposed = false;
    void commandsApi.list()
      .then((catalog) => { if (!disposed) setCommands(catalog.commands); })
      .catch(() => { if (!disposed) setCommands([]); });
    return () => { disposed = true; };
  }, [open, showCommands]);

  // 已有 Session 由后端找到它所属的项目; 新对话则直接使用当前选中的项目.
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
      // 设置页连续改动技能时合并刷新; 上面的 requestId 负责防止旧请求覆盖新结果.
      refreshTimer = setTimeout(refresh, 150);
    });
    return () => {
      disposed = true;
      unsubscribe();
      clearTimeout(refreshTimer);
    };
  }, [open, sessionId, projectId]);

  const items = useMemo<FlatItem[]>(() => {
    // 同名时以后端目录为准, 避免菜单展示两个无法区分的 /命令.
    const catalogNames = new Set(commands.map((command) => command.name));
    const commandItems: FlatItem[] = showCommands ? [
      ...commands
        .filter((command) => command.name !== 'compact' || compactAvailable)
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
    ] : [];
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
  }, [commands, skills, filter, showCommands, compactAvailable]);

  // 搜索词或候选项数量变化后, Enter 从第一项开始选.
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
              <span className="text-xs shrink-0">{item.title}</span>
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
