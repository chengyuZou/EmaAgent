// 把后端扁平设置目录投影为前端的参数域与页面分节，不借用后端的校验组语义。
import type { SettingsCatalogItem } from '../../api/settings.js';

export interface SettingSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SettingsCatalogItem[];
}

export interface SettingDomain {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly sections: readonly SettingSection[];
}

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  agent: 'Agent',
  attachments: '附件',
  characters: '角色表现',
  context: '上下文',
  frontend: '桌面与外观',
  git: 'Git',
  kb: 'Knowledge Base',
  memory: 'Memory',
  permission: '权限',
  skill: 'Skills',
  speech: '语音',
  tools: 'Tools',
  workspace: '工作区',
};

const DOMAIN_ICONS: Readonly<Record<string, string>> = {
  agent: 'i-lucide:bot',
  attachments: 'i-lucide:paperclip',
  characters: 'i-lucide:smile',
  context: 'i-lucide:gauge',
  frontend: 'i-lucide:palette',
  git: 'i-lucide:git-branch',
  kb: 'i-lucide:database',
  memory: 'i-lucide:brain',
  permission: 'i-lucide:shield-check',
  skill: 'i-lucide:blocks',
  speech: 'i-lucide:audio-lines',
  tools: 'i-lucide:wrench',
  workspace: 'i-lucide:folder-kanban',
};

const SECTION_LABELS: Readonly<Record<string, string>> = {
  baseline: '基线',
  budgets: '业务预算',
  cache: '缓存',
  compact: '压缩',
  diff: 'Diff',
  illustration: '立绘',
  input: '输入限制',
  jobs: '后台任务',
  limits: '执行限制',
  live2d: 'Live2D',
  output: '输出',
  relationship: '关系记忆',
  retrieval: '检索',
  rules: '规则',
  segments: '音频片段',
  storage: '存储',
  thinking: '推理',
  timeout: '超时',
  voice: '声音',
  work: '工作记忆',
};

/** 这些值由专属界面编辑，通用参数页不重复提供第二个写入口。 */
const SPECIALIZED_SETTING_KEYS = new Set([
  'frontend.eventDisplay',
  'frontend.terminal.shellExecutable',
  'frontend.theme',
]);

export function buildSettingDomains(items: readonly SettingsCatalogItem[]): SettingDomain[] {
  const byDomain = new Map<string, Map<string, SettingsCatalogItem[]>>();

  for (const item of items) {
    if (SPECIALIZED_SETTING_KEYS.has(item.key)) continue;
    const segments = item.key.split('.');
    const domainId = segments[0];
    if (!domainId) continue;
    const sectionId = segments.length > 2 ? segments.slice(1, -1).join('.') : 'general';
    const sections = byDomain.get(domainId) ?? new Map<string, SettingsCatalogItem[]>();
    const sectionItems = sections.get(sectionId) ?? [];
    sectionItems.push(item);
    sections.set(sectionId, sectionItems);
    byDomain.set(domainId, sections);
  }

  return [...byDomain.entries()]
    .sort(([left], [right]) => domainLabel(left).localeCompare(domainLabel(right), 'zh-CN'))
    .map(([domainId, sections]) => ({
      id: domainId,
      label: domainLabel(domainId),
      icon: DOMAIN_ICONS[domainId] ?? 'i-lucide:sliders-horizontal',
      sections: [...sections.entries()]
        .sort(([left], [right]) => sectionLabel(left).localeCompare(sectionLabel(right), 'zh-CN'))
        .map(([sectionId, sectionItems]) => ({
          id: sectionId,
          label: sectionLabel(sectionId),
          items: [...sectionItems].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN')),
        })),
    }));
}

export function searchSettingItems(
  items: readonly SettingsCatalogItem[],
  query: string,
): SettingsCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return items.filter((item) => !SPECIALIZED_SETTING_KEYS.has(item.key) && [
    item.key,
    item.label,
    item.description,
  ].some((text) => text.toLocaleLowerCase().includes(needle)));
}

function domainLabel(id: string): string {
  return DOMAIN_LABELS[id] ?? id;
}

function sectionLabel(id: string): string {
  if (id === 'general') return '常规';
  const leaf = id.split('.').at(-1) ?? id;
  return SECTION_LABELS[leaf] ?? leaf;
}
