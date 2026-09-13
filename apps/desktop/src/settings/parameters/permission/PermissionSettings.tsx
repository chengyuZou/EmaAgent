// 编辑全局与已有项目的权限规则, 以及交互等待时间.
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Input, Select, Spinner, Textarea } from '@ema-agent/ui';
import { sessionsApi, type Project } from '../../../api/sessions.js';
import type { SettingApply } from '../../../api/settings.js';
import { SettingsCard, SettingsSection, SettingItem } from '../../shared/SettingItem.js';
import { useSettingValues } from '../useSettingValues.js';

const TIMEOUT_KEY = 'permission.askTimeoutMs';
const USER_RULE_KEYS = {
  allow: 'permission.rules.user.allow',
  deny: 'permission.rules.user.deny',
  ask: 'permission.rules.user.ask',
} as const;
const PROJECT_RULE_KEYS = {
  allow: 'permission.rules.project.allow',
  deny: 'permission.rules.project.deny',
  ask: 'permission.rules.project.ask',
} as const;

type RuleBehavior = keyof typeof USER_RULE_KEYS;

export function PermissionSettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">权限设置读取失败: {settings.error}</Callout>;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-10">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">权限规则</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">控制 Tool 在执行前是直接允许, 直接拒绝还是询问.</p>
      </header>

      <SettingsSection icon="i-lucide:shield-check" title="用户确认" description="Tool 需要询问时的等待时间">
        <SettingsCard>
          <PermissionTimeout apply={settings.apply(TIMEOUT_KEY)} value={readNullableNumber(settings.values, TIMEOUT_KEY)} onSave={value => settings.save(TIMEOUT_KEY, value)} onReset={() => settings.reset(TIMEOUT_KEY)} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection icon="i-lucide:list-checks" title="全局规则" description="每行一条 Tool 或 Tool(content) 规则">
        <SettingsCard>
          {(['deny', 'ask', 'allow'] as const).map(behavior => (
            <RuleListEditor
              key={behavior}
              behavior={behavior}
              apply={settings.apply(USER_RULE_KEYS[behavior])}
              value={readStringArray(settings.values, USER_RULE_KEYS[behavior])}
              onSave={value => settings.save(USER_RULE_KEYS[behavior], value)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <ProjectRules values={settings.values} apply={settings.apply} save={settings.save} />
    </div>
  );
}

function PermissionTimeout(props: { apply: SettingApply; value: number | null; onSave(value: number | null): Promise<void>; onReset(): Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState(props.value === null ? '' : String(props.value / 1000));
  useEffect(() => setDraft(props.value === null ? '' : String(props.value / 1000)), [props.value]);
  return (
    <SettingItem title="等待用户确认" hint="留空表示一直等待. 填写秒数后, 超时自动拒绝本次操作." apply={props.apply}>
      <Input className="w-28" inputSize="sm" type="number" value={draft} placeholder="一直等待" onChange={event => setDraft(event.target.value)} onBlur={() => {
        const trimmed = draft.trim();
        if (!trimmed) void props.onSave(null);
        else {
          const seconds = Number(trimmed);
          if (Number.isFinite(seconds)) void props.onSave(seconds * 1000);
        }
      }} />
      <span className="text-xs text-[var(--ema-text-tertiary)]">秒</span>
      <Button variant="ghost" size="sm" onClick={() => void props.onReset()} title="恢复默认值"><span className="i-lucide:rotate-ccw" aria-hidden /></Button>
    </SettingItem>
  );
}

function RuleListEditor(props: { behavior: RuleBehavior; apply: SettingApply; value: readonly string[]; onSave(value: string[]): Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState(props.value.join('\n'));
  useEffect(() => setDraft(props.value.join('\n')), [props.value]);
  const label = { allow: '允许', deny: '拒绝', ask: '每次询问' }[props.behavior];
  return (
    <SettingItem title={`${label}规则`} hint="例如 Bash(pnpm test:*), Read(./src/**)." apply={props.apply}>
      <Textarea className="h-24 w-[30rem] max-w-[45vw] font-mono text-xs" value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => void props.onSave(parseRules(draft))} />
    </SettingItem>
  );
}

function ProjectRules(props: { values: ReadonlyMap<string, unknown>; apply(key: string): SettingApply; save(key: string, value: unknown): Promise<void> }): JSX.Element {
  const records = {
    allow: readRuleRecord(props.values, PROJECT_RULE_KEYS.allow),
    deny: readRuleRecord(props.values, PROJECT_RULE_KEYS.deny),
    ask: readRuleRecord(props.values, PROJECT_RULE_KEYS.ask),
  };
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    void sessionsApi.listForSidebar()
      .then(sidebarData => setProjects([...sidebarData.pinnedProjects, ...sidebarData.projects]))
      .catch(error => setLoadError(error instanceof Error ? error.message : '项目列表读取失败'));
  }, []);
  useEffect(() => {
    if (!projects.some(project => project.id === selected)) {
      setSelected(projects[0]?.id ?? '');
    }
  }, [projects, selected]);

  const saveRules = async (behavior: RuleBehavior, rules: string[]): Promise<void> => {
    if (!selected) return;
    const current = records[behavior];
    const next = { ...current };
    if (rules.length === 0) delete next[selected];
    else next[selected] = rules;
    await props.save(PROJECT_RULE_KEYS[behavior], next);
  };

  return (
    <SettingsSection icon="i-lucide:folder-key" title="项目规则" description="只覆盖指定项目, 规则格式与全局规则相同">
      <SettingsCard>
        {loadError && <Callout variant="danger">{loadError}</Callout>}
        {!loadError && projects.length === 0 && <p className="px-4 py-3 text-sm text-[var(--ema-text-tertiary)]">暂无项目</p>}
        {projects.length > 0 && (
          <SettingItem title="项目" hint="仅选择 Session 中已有的项目.">
            <Select
              className="w-64"
              value={selected}
              options={projects.map(project => ({ value: project.id, label: project.name }))}
              onChange={setSelected}
            />
          </SettingItem>
        )}
        {selected && (['deny', 'ask', 'allow'] as const).map(behavior => (
          <RuleListEditor key={`${selected}:${behavior}`} behavior={behavior} apply={props.apply(PROJECT_RULE_KEYS[behavior])} value={records[behavior][selected] ?? []} onSave={value => saveRules(behavior, value)} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function parseRules(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

function readNullableNumber(values: ReadonlyMap<string, unknown>, key: string): number | null {
  const value = values.get(key);
  if (value !== null && typeof value !== 'number') throw new Error(`设置 ${key} 没有返回数字或 null`);
  return value;
}

function readStringArray(values: ReadonlyMap<string, unknown>, key: string): string[] {
  const value = values.get(key);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`设置 ${key} 没有返回字符串数组`);
  return value;
}

function readRuleRecord(values: ReadonlyMap<string, unknown>, key: string): Record<string, string[]> {
  const value = values.get(key);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`设置 ${key} 没有返回项目规则`);
  return value as Record<string, string[]>;
}
