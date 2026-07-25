// 提供权限等待时间和结构化事件通知等跨业务通用设置。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Input } from '@ema-agent/ui';
import { useSettingsStore } from '../stores/settings-store.js';
import { showToast } from '../lib/toast.js';
import { EventDisplaySettings } from './EventDisplaySettings.js';
import { PermissionRulesSettings } from './PermissionRulesSettings.js';

export function GeneralTab(): JSX.Element {
  const savedTimeoutMs = useSettingsStore((state) => state.permissionTimeoutMs);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(savedTimeoutMs / 1000));
  const [savingTimeout, setSavingTimeout] = useState(false);

  useEffect(() => {
    setTimeoutSeconds(String(savedTimeoutMs / 1000));
  }, [savedTimeoutMs]);

  const parsedSeconds = Number(timeoutSeconds);
  const timeoutValid = Number.isInteger(parsedSeconds) && parsedSeconds >= 5 && parsedSeconds <= 600;
  const timeoutDirty = timeoutValid && parsedSeconds * 1000 !== savedTimeoutMs;

  async function saveTimeout(): Promise<void> {
    if (!timeoutValid) return;
    setSavingTimeout(true);
    try {
      await useSettingsStore.getState().putPermissionTimeout(parsedSeconds * 1000);
      showToast('权限等待时间已保存', { variant: 'success' });
    } catch (error: unknown) {
      showToast(error instanceof Error ? `保存失败：${error.message}` : '权限等待时间保存失败', { variant: 'danger' });
    } finally {
      setSavingTimeout(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-8">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">通用设置</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          管理跨 Session 生效的权限确认与事件通知行为。
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">工具权限</h2>
          <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">
            工具等待确认超过该时间后由权限引擎按超时处理；已经弹出的请求保持创建时的截止时间。
          </p>
        </div>
        <div className="ema-glass-weak flex flex-wrap items-end gap-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-4">
          <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
            等待时间（秒）
            <Input
              type="number"
              min={5}
              max={600}
              step={1}
              value={timeoutSeconds}
              error={timeoutSeconds.length > 0 && !timeoutValid}
              onChange={(event) => setTimeoutSeconds(event.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={!timeoutDirty || savingTimeout}
            onClick={() => setTimeoutSeconds(String(savedTimeoutMs / 1000))}
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={savingTimeout}
            disabled={!timeoutDirty}
            onClick={() => void saveTimeout()}
          >
            保存更改
          </Button>
        </div>
        {!timeoutValid && timeoutSeconds.length > 0 && (
          <Callout variant="danger">请输入 5 到 600 之间的整数秒数。</Callout>
        )}
      </section>

      <div className="h-px bg-[var(--ema-border)]" />
      <PermissionRulesSettings />

      <div className="h-px bg-[var(--ema-border)]" />
      <EventDisplaySettings />
    </div>
  );
}
