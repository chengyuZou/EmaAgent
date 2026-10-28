import {
  permissionAskTimeoutSetting,
  permissionRulesUserAllowSetting,
  permissionRulesUserDenySetting,
  permissionRulesUserAskSetting,
  permissionRulesProjectAllowSetting,
  permissionRulesProjectDenySetting,
  permissionRulesProjectAskSetting,
} from '@ema-agent/server/settings';
import { useEffect, useState, type JSX } from 'react';
import { Tooltip, Button, Callout, Input, Select, Spinner, Textarea } from '@ema-agent/ui';
import { sessionsApi, type Project } from '../../api/sessions.js';
import type { SettingApply } from '../../api/settings.js';
import { PageHeader } from '../shared/PageHeader.js';
import { SettingsCard, SettingsSection, SettingItem } from '../shared/SettingItem.js';
import { useSettingValues } from '../shared/useSettingValues.js';

const USER_RULE_SETTINGS = {
  allow: permissionRulesUserAllowSetting,
  deny: permissionRulesUserDenySetting,
  ask: permissionRulesUserAskSetting,
} as const;
const PROJECT_RULE_SETTINGS = {
  allow: permissionRulesProjectAllowSetting,
  deny: permissionRulesProjectDenySetting,
  ask: permissionRulesProjectAskSetting,
} as const;

type RuleBehavior = keyof typeof USER_RULE_SETTINGS;

export function PermissionSettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">权限设置读取失败: {settings.error}</Callout>;

  return (
    <div className="mx-auto flex w-full flex-col gap-8 pb-10">
      <PageHeader title="权限" description="控制 Tool 在执行前是直接允许, 直接拒绝还是询问." />

      <SettingsSection icon="i-lucide:shield-check" title="用户确认" description="Tool 需要询问时的等待时间">
        <SettingsCard>
          <PermissionTimeout
            apply={settings.apply(permissionAskTimeoutSetting)}
            value={settings.get(permissionAskTimeoutSetting)}
            onSave={value => settings.save(permissionAskTimeoutSetting, value)}
            onReset={() => settings.reset(permissionAskTimeoutSetting)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection icon="i-lucide:list-checks" title="全局规则" description="每行一条 Tool 或 Tool(content) 规则">
        <SettingsCard>
          {(['deny', 'ask', 'allow'] as const).map(behavior => (
            <RuleListEditor
              key={behavior}
              behavior={behavior}
              apply={settings.apply(USER_RULE_SETTINGS[behavior])}
              value={settings.get(USER_RULE_SETTINGS[behavior])}
              onSave={value => settings.save(USER_RULE_SETTINGS[behavior], value)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <ProjectRules get={settings.get} apply={settings.apply} save={settings.save} />
    </div>
  );
}

function PermissionTimeout(props: {
  apply: SettingApply;
  value: number | null;
  onSave(value: number | null): Promise<void>;
  onReset(): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(props.value === null ? '' : String(props.value / 1000));
  useEffect(() => setDraft(props.value === null ? '' : String(props.value / 1000)), [props.value]);
  return (
    <SettingItem title="等待用户确认" hint="留空表示一直等待. 填写秒数后, 超时自动拒绝本次操作." apply={props.apply}>
      <Input
        className="w-28"
        inputSize="sm"
        type="number"
        value={draft}
        placeholder="一直等待"
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          if (!trimmed) void props.onSave(null);
          else {
            const seconds = Number(trimmed);
            if (Number.isFinite(seconds)) void props.onSave(seconds * 1000);
          }
        }}
      />
      <span className="text-xs text-[var(--ema-text-tertiary)]">秒</span>
      <Tooltip content="恢复默认值">
        <Button
          variant="ghost"
          size="sm"
          aria-label="恢复默认值"
          onClick={() => void props.onReset()}
        >
          <span className="i-lucide:rotate-ccw" aria-hidden />
        </Button>
      </Tooltip>
    </SettingItem>
  );
}

function RuleListEditor(props: { behavior: RuleBehavior; apply: SettingApply; value: readonly string[]; onSave(value: string[]): Promise<void> }): JSX.Element {
  const [draft, setDraft] = useState(props.value.join('\n'));
  useEffect(() => {
    setDraft(props.value.join('\n'))
  }, [props.value]);

  const label = { allow: '允许', deny: '拒绝', ask: '需要确认' }[props.behavior];
  return (
    <SettingItem title={`${label}规则`} hint="例如 Bash(pnpm test:*), Read(./src/**)." apply={props.apply}>
      <Textarea
        className="h-24 w-[30rem] max-w-[45vw] font-mono text-xs resize-none border-none"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => void props.onSave(parseRules(draft))}
      />
    </SettingItem>
  );
}

function ProjectRules(props: Pick<ReturnType<typeof useSettingValues>, 'get' | 'apply' | 'save'>): JSX.Element {
  const records = {
    allow: props.get(PROJECT_RULE_SETTINGS.allow),
    deny: props.get(PROJECT_RULE_SETTINGS.deny),
    ask: props.get(PROJECT_RULE_SETTINGS.ask),
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
    await props.save(PROJECT_RULE_SETTINGS[behavior], next);
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
          <RuleListEditor
            key={`${selected}:${behavior}`}
            behavior={behavior}
            apply={props.apply(PROJECT_RULE_SETTINGS[behavior])}
            value={records[behavior][selected] ?? []}
            onSave={value => saveRules(behavior, value)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function parseRules(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}
