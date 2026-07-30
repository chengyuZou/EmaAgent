// 管理跨 Session 持久生效的工具权限规则。
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Callout, Input, Select, Switch } from '@ema-agent/ui';
import type {
  PermissionRule,
  PersistedPermissionRule,
  RuleScope,
} from '@ema-agent/permission';
import { permissionApi } from '../../api/permission.js';
import { showToast } from '../../lib/toast.js';

type RuleAction = PermissionRule['action'];

const ACTION_OPTIONS = [
  { value: 'allow', label: '始终允许' },
  { value: 'ask', label: '每次询问' },
  { value: 'deny', label: '始终拒绝' },
];

const SCOPE_OPTIONS = [
  { value: 'global', label: '全部工作区' },
  { value: 'workspace', label: '指定工作区' },
];

export function PermissionRulesSettings(): JSX.Element {
  const [rules, setRules] = useState<PersistedPermissionRule[]>([]);
  const [action, setAction] = useState<RuleAction>('ask');
  const [scope, setScope] = useState<RuleScope>('global');
  const [tool, setTool] = useState('');
  const [pathGlob, setPathGlob] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const loadRules = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await permissionApi.listRules();
      setRules(result.rules);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '权限规则加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const normalizedTool = tool.trim();
  const normalizedWorkspace = workspaceRoot.trim();
  const valid = normalizedTool.length > 0
    && (scope === 'global' || normalizedWorkspace.length > 0);

  async function saveRule(): Promise<void> {
    if (!valid) return;
    setSaving(true);
    setError(undefined);
    try {
      const input: PermissionRule = {
        action,
        scope,
        tool: normalizedTool,
        ...(pathGlob.trim() ? { pathGlob: pathGlob.trim() } : {}),
        ...(scope === 'workspace' ? { workspaceRoot: normalizedWorkspace } : {}),
      };
      await permissionApi.addRule(input);
      setTool('');
      setPathGlob('');
      await loadRules();
      showToast('权限规则已保存', { variant: 'success' });
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : '权限规则保存失败';
      setError(message);
      showToast(`保存失败：${message}`, { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: PersistedPermissionRule, enabled: boolean): Promise<void> {
    setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled } : item));
    try {
      await permissionApi.setRuleEnabled(rule.id, enabled);
    } catch (cause: unknown) {
      setRules((current) => current.map((item) => item.id === rule.id ? rule : item));
      showToast(cause instanceof Error ? cause.message : '规则状态更新失败', { variant: 'danger' });
    }
  }

  async function removeRule(ruleId: string): Promise<void> {
    try {
      await permissionApi.removeRule(ruleId);
      setRules((current) => current.filter((rule) => rule.id !== ruleId));
      showToast('权限规则已删除', { variant: 'success' });
    } catch (cause: unknown) {
      showToast(cause instanceof Error ? cause.message : '权限规则删除失败', { variant: 'danger' });
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">永久权限规则</h2>
        <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">
          规则保存在本机 profile.db。工具填写稳定 ID，* 表示全部工具；路径模式为空时匹配该工具的所有目标。
        </p>
      </div>

      <div className="ema-glass-weak grid gap-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
          行为
          <Select
            value={action}
            onChange={(value) => setAction(value as RuleAction)}
            options={ACTION_OPTIONS}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
          生效范围
          <Select
            value={scope}
            onChange={(value) => setScope(value as RuleScope)}
            options={SCOPE_OPTIONS}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
          工具 ID
          <Input
            value={tool}
            placeholder="例如 file_read 或 *"
            maxLength={128}
            onChange={(event) => setTool(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
          路径模式（可选）
          <Input
            value={pathGlob}
            placeholder="例如 src/**"
            maxLength={2048}
            onChange={(event) => setPathGlob(event.target.value)}
          />
        </label>
        {scope === 'workspace' && (
          <label className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)] md:col-span-2">
            工作区绝对路径
            <Input
              value={workspaceRoot}
              placeholder="例如 D:\Github\EmaAgent"
              maxLength={4096}
              onChange={(event) => setWorkspaceRoot(event.target.value)}
            />
          </label>
        )}
        <div className="flex justify-end md:col-span-2">
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!valid}
            onClick={() => void saveRule()}
          >
            添加规则
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}

      <div className="flex flex-col gap-2">
        {loading && (
          <div className="rounded-lg border border-[var(--ema-border)] px-4 py-3 text-sm text-[var(--ema-text-tertiary)]">
            正在加载权限规则…
          </div>
        )}
        {!loading && rules.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--ema-border)] px-4 py-5 text-center text-sm text-[var(--ema-text-tertiary)]">
            暂无永久规则。临时的“本会话允许此操作”不会写入这里。
          </div>
        )}
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="ema-glass-weak flex items-center gap-3 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3"
          >
            <Switch
              checked={rule.enabled}
              label={`${rule.enabled ? '停用' : '启用'} ${rule.tool} 规则`}
              onCheckedChange={(enabled) => void toggleRule(rule, enabled)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--ema-text-primary)]">
                <span className="font-medium">{actionLabel(rule.action)}</span>
                <code className="rounded bg-[var(--ema-surface-2)] px-1.5 py-0.5 text-xs">{rule.tool}</code>
                <span className="text-xs text-[var(--ema-text-tertiary)]">
                  {rule.scope === 'global' ? '全部工作区' : rule.workspaceRoot}
                </span>
              </div>
              {rule.pathGlob && (
                <p className="mt-1 truncate text-xs text-[var(--ema-text-tertiary)]">
                  路径：{rule.pathGlob}
                </p>
              )}
            </div>
            <Button
              variant="danger"
              size="sm"
              icon="i-mdi:delete-outline"
              aria-label={`删除 ${rule.tool} 规则`}
              onClick={() => void removeRule(rule.id)}
            >
              删除
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function actionLabel(action: RuleAction): string {
  if (action === 'allow') return '始终允许';
  if (action === 'deny') return '始终拒绝';
  return '每次询问';
}
