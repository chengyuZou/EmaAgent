import { useEffect, useState, type JSX } from 'react';
import { commandEnvironmentSetting } from '@ema-agent/server/settings';
import { Button, Callout, Spinner, Textarea } from '@ema-agent/ui';
import { settingsApi } from '../../api/settings.js';
import { KeyValueEditor, type KeyValuePair } from '../shared/KeyValueEditor.js';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';

export function CommandEnvironmentSettings(): JSX.Element {
  const [pairs, setPairs] = useState<KeyValuePair[]>([]);
  const [passthrough, setPassthrough] = useState('');
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoaded(false);
    setError('');
    void settingsApi.getValue(commandEnvironmentSetting).then(({ value }) => {
      if (!active) return;
      setPairs(Object.entries(value.values).map(([key, value]) => ({ key, value })));
      setPassthrough(value.passthrough.join('\n'));
      setLoaded(true);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : '命令环境读取失败.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reload]);

  async function save(reset = false): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      if (reset) {
        await settingsApi.deleteValue(commandEnvironmentSetting);
        setPairs([]);
        setPassthrough('');
      } else {
        const names = pairs.map(pair => pair.key.trim());
        if (new Set(names.map(name => name.toUpperCase())).size !== names.length) {
          throw new Error('环境变量名不能重复, 请合并同名项.');
        }
        const result = commandEnvironmentSetting.schema.safeParse({
          values: Object.fromEntries(pairs.map((pair, index) => [names[index], pair.value])),
          passthrough: [...new Set(passthrough.split(/[\s,]+/).filter(Boolean))],
        });
        if (!result.success) {
          // 不展示含凭据的输入或服务端校验对象.
          throw new Error('变量名只能包含英文字母, 数字和下划线, 不能以数字开头或使用 EMA_SHARED_SECRET.');
        }
        await settingsApi.putValue(commandEnvironmentSetting, result.data);
      }
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '命令环境保存失败.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon="i-lucide:key-round"
      title="Agent 命令环境"
      description="Bash 和 PowerShell 默认只继承系统运行所需变量. 以下设置从下一个 Turn 生效, 不影响集成终端或 MCP 的独立配置."
    >
      {loading ? <Spinner size="md" /> : (
        <SettingsCard>
          <fieldset disabled={saving || !loaded} className="flex min-w-0 flex-col gap-4 p-4">
            <label className="flex flex-col gap-2 text-sm">
              从 Server 继承的变量名
              <Textarea
                value={passthrough}
                onChange={event => { setPassthrough(event.target.value); setSaved(false); }}
                minRows={2}
                maxRows={6}
                placeholder="HTTPS_PROXY, OPENAI_API_KEY"
                className="font-mono"
              />
              <span className="text-xs text-[var(--ema-text-secondary)]">用换行或逗号分隔. 未在 Server 环境中设置的变量会跳过.</span>
            </label>
            <div className="flex min-w-0 flex-col gap-2 text-sm">
              显式设置的变量
              <KeyValueEditor
                pairs={pairs}
                onChange={value => { setPairs(value); setSaved(false); }}
                keyPlaceholder="VARIABLE_NAME"
                valuePlaceholder="Value"
                secret
              />
              <p className="text-xs text-[var(--ema-text-secondary)]">
                显式值覆盖继承值, 以明文保存在本机设置中. Ema 的内部控制口令不允许传给命令.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
              <Button variant="ghost" onClick={() => void save(true)}>恢复默认</Button>
              {saved && <span role="status" className="text-sm text-[var(--ema-text-secondary)]">已保存, 下一个 Turn 生效.</span>}
            </div>
          </fieldset>
        </SettingsCard>
      )}
      {error && <Callout variant="danger">{error}</Callout>}
      {!loading && !loaded && <Button onClick={() => setReload(value => value + 1)}>重新读取</Button>}
    </SettingsSection>
  );
}
