// 编辑结构化事件通知的开关、强调色、停留时间和文本截断长度。
// GET event-display 是默认表+用户覆盖的生效表;草稿编辑的是用户覆盖表(整表替换写回)。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Badge, Button, Callout, Input, Select, Spinner, Switch } from '@ema-agent/ui';
import { useSettingsStore, type EventDisplayConfig } from '../../stores/settings.js';
import { settingsApi, type SettingApply } from '../../api/settings.js';
import { showToast } from '../../lib/toast.js';
import { SettingApplyBadge } from '../shared/SettingItem.js';
import {
  EVENT_DISPLAY_GROUPS,
  eventDisplayGroup,
  eventDisplayLabel,
} from './event-display-catalog.js';

const EVENT_DISPLAY_SETTING_KEY = 'frontend.eventDisplay';

const DURATION_OPTIONS = [
  { value: '1000', label: '1 秒' },
  { value: '2000', label: '2 秒' },
  { value: '3000', label: '3 秒' },
  { value: '4000', label: '4 秒' },
  { value: '5000', label: '5 秒' },
  { value: '8000', label: '8 秒' },
  { value: 'null', label: '保持显示' },
];

function configEquals(
  left: Record<string, EventDisplayConfig>,
  right: Record<string, EventDisplayConfig>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 原始覆盖表只接受对象;损坏形状当空表编辑。 */
function readOverrides(value: unknown): Record<string, EventDisplayConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, EventDisplayConfig>;
}

export function EventDisplaySettings(): JSX.Element {
  const eventDisplay = useSettingsStore((state) => state.eventDisplay);
  const storeError = useSettingsStore((state) => state.error);
  const [rawOverrides, setRawOverrides] = useState<Record<string, EventDisplayConfig> | null>(null);
  const [draftOverrides, setDraftOverrides] = useState<Record<string, EventDisplayConfig>>({});
  const [apply, setApply] = useState<SettingApply | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const result = await settingsApi.getValue(EVENT_DISPLAY_SETTING_KEY);
        const overrides = readOverrides(result.value);
        setRawOverrides(overrides);
        setDraftOverrides(overrides);
        setApply(result.apply);
      } catch {
        setRawOverrides(null);
      }
    })();
  }, []);

  useEffect(() => {
    if (eventDisplay) return;
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
  }, [eventDisplay]);

  const filteredTypes = useMemo(() => {
    if (!eventDisplay) return [];
    const query = search.trim().toLowerCase();
    return Object.keys(eventDisplay).filter((eventType) => (
      !query
      || eventType.toLowerCase().includes(query)
      || eventDisplayLabel(eventType).toLowerCase().includes(query)
    ));
  }, [eventDisplay, search]);

  if (!eventDisplay || rawOverrides === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-[var(--ema-text-tertiary)]">
        {storeError ? (
          <>
            <Callout variant="danger">事件设置加载失败:{storeError}</Callout>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void useSettingsStore.getState().refreshDesktopSettings().catch(() => {})}
            >
              重试
            </Button>
          </>
        ) : (
          <><Spinner size="sm" /> 正在加载事件设置…</>
        )}
      </div>
    );
  }

  const effective = eventDisplay;
  const dirty = !configEquals(draftOverrides, rawOverrides);
  const draftValid = Object.values(draftOverrides).every((config) => (
    /^#[0-9a-fA-F]{6}$/.test(config.color)
    && (config.durationMs === null || (
      Number.isInteger(config.durationMs)
      && config.durationMs >= 0
      && config.durationMs <= 600_000
    ))
    && (config.truncateChars === undefined || (
      Number.isInteger(config.truncateChars)
      && config.truncateChars >= 1
      && config.truncateChars <= 10_000
    ))
  ));

  function currentConfig(eventType: string): EventDisplayConfig | undefined {
    return draftOverrides[eventType] ?? effective[eventType];
  }

  function patchConfig(eventType: string, patch: Partial<EventDisplayConfig>): void {
    setDraftOverrides((current) => {
      const base = current[eventType] ?? effective[eventType];
      if (!base) return current;
      return { ...current, [eventType]: { ...base, ...patch } };
    });
  }

  function restoreDefault(eventType: string): void {
    setDraftOverrides((current) => {
      const next = { ...current };
      delete next[eventType];
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!draftValid) return;
    setSaving(true);
    try {
      // 整表替换:store 的 putEventDisplay 是增量合并语义,表达不了"恢复默认"的删除。
      await settingsApi.putValue(EVENT_DISPLAY_SETTING_KEY, draftOverrides);
      setRawOverrides(draftOverrides);
      await useSettingsStore.getState().refreshEventDisplay();
      showToast('事件展示设置已保存', { variant: 'success' });
    } catch (error: unknown) {
      showToast(error instanceof Error ? `保存失败:${error.message}` : '事件展示设置保存失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">事件通知</h2>
            {apply && <SettingApplyBadge apply={apply} />}
          </div>
          <p className="mt-1 text-xs text-[var(--ema-text-tertiary)]">
            控制工具、记忆、知识库和系统事件是否显示为本地通知。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setDraftOverrides(rawOverrides)}
          >
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty || !draftValid} onClick={() => void save()}>
            保存更改
          </Button>
        </div>
      </div>

      <Callout variant="info">
        “保持显示”的通知需要手动关闭。语音数据块和子 Agent 详情流属于高频内部事件，不列入通知设置。
      </Callout>
      {!draftValid && (
        <Callout variant="danger">文本上限必须是 1 到 10000 之间的整数。</Callout>
      )}

      <Input
        inputSize="sm"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="搜索事件名称或协议字段…"
        className="max-w-sm"
      />

      {EVENT_DISPLAY_GROUPS.map((group) => {
        const eventTypes = filteredTypes.filter((eventType) => eventDisplayGroup(eventType) === group.id);
        if (eventTypes.length === 0) return null;
        return (
          <div key={group.id} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ema-text-tertiary)]">
              {group.label}
            </h3>
            {eventTypes.map((eventType) => {
              const config = currentConfig(eventType);
              if (!config) return null;
              const overridden = eventType in draftOverrides;
              const durationValue = config.durationMs === null ? 'null' : String(config.durationMs);
              const durationOptions = DURATION_OPTIONS.some((option) => option.value === durationValue)
                ? DURATION_OPTIONS
                : [{ value: durationValue, label: `${config.durationMs} ms` }, ...DURATION_OPTIONS];
              return (
                <div
                  key={eventType}
                  className="ema-glass-weak grid gap-3 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-4 py-3 lg:grid-cols-[minmax(220px,1fr)_auto_130px_88px_84px] lg:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--ema-text-primary)]">
                        {eventDisplayLabel(eventType)}
                      </span>
                      {overridden && <Badge variant="primary">已自定义</Badge>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--ema-text-tertiary)]">
                      {eventType}
                    </p>
                  </div>

                  <Switch
                    checked={config.enabled}
                    onCheckedChange={(enabled) => patchConfig(eventType, { enabled })}
                    label={`${eventDisplayLabel(eventType)}通知`}
                  />

                  <Select
                    value={durationValue}
                    options={durationOptions}
                    disabled={!config.enabled}
                    onChange={(value) => patchConfig(eventType, {
                      durationMs: value === 'null' ? null : Number(value),
                    })}
                  />

                  <label className="flex items-center gap-2">
                    <input
                      type="color"
                      value={config.color}
                      disabled={!config.enabled}
                      aria-label={`${eventDisplayLabel(eventType)}强调色`}
                      className="h-7 w-9 cursor-pointer rounded border border-[var(--ema-border)] bg-transparent disabled:cursor-not-allowed disabled:opacity-40"
                      onChange={(event) => patchConfig(eventType, { color: event.target.value })}
                    />
                    <span className="font-mono text-[10px] text-[var(--ema-text-tertiary)]">{config.color}</span>
                  </label>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!overridden}
                    onClick={() => restoreDefault(eventType)}
                  >
                    恢复默认
                  </Button>

                  <label className="lg:col-start-1 lg:col-span-5 flex max-w-xs items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
                    文本上限
                    <Input
                      inputSize="sm"
                      type="number"
                      min={1}
                      max={10_000}
                      disabled={!config.enabled}
                      value={config.truncateChars ?? ''}
                      placeholder="不限"
                      className="w-24"
                      onChange={(event) => patchConfig(eventType, {
                        truncateChars: event.target.value ? Number(event.target.value) : undefined,
                      })}
                    />
                    字符
                  </label>
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
