// 编辑结构化事件通知的开关、强调色、停留时间和文本截断长度。
// 与其它参数页同章法:改动即存(用户覆盖表整表替换写回),行尾"恢复默认"=删该事件的覆盖键。
import { useEffect, useState, type JSX } from 'react';
import { Badge, Button, Callout, Input, Select, Spinner, Switch } from '@ema-agent/ui';
import { useSettingsStore, type EventDisplayConfig } from '../../../stores/settings.js';
import { settingsApi, type SettingApply } from '../../../api/settings.js';
import { showToast } from '../../../lib/toast.js';
import {
  SaveStateIndicator,
  SettingApplyBadge,
  SettingsCard,
  SettingsSection,
} from '../../shared/SettingItem.js';
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

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** 原始覆盖表只接受对象;损坏形状当空表编辑。 */
function readOverrides(value: unknown): Record<string, EventDisplayConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, EventDisplayConfig>;
}

export function EventDisplayParameters(): JSX.Element {
  const eventDisplay = useSettingsStore((state) => state.eventDisplay);
  const storeError = useSettingsStore((state) => state.error);
  const [overrides, setOverrides] = useState<Record<string, EventDisplayConfig> | null>(null);
  const [apply, setApply] = useState<SettingApply | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    void (async () => {
      try {
        const result = await settingsApi.getValue(EVENT_DISPLAY_SETTING_KEY);
        setOverrides(readOverrides(result.value));
        setApply(result.apply);
      } catch {
        setOverrides(null);
      }
    })();
  }, []);

  useEffect(() => {
    if (eventDisplay) return;
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
  }, [eventDisplay]);

  if (!eventDisplay || overrides === null) {
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
  const current = overrides;

  /** 整表替换写回:恢复默认的删除语义只有整表能表达。 */
  async function persist(next: Record<string, EventDisplayConfig>): Promise<void> {
    setSaveState('saving');
    try {
      await settingsApi.putValue(EVENT_DISPLAY_SETTING_KEY, next);
      setOverrides(next);
      await useSettingsStore.getState().refreshEventDisplay();
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_200);
    } catch (error: unknown) {
      setSaveState('failed');
      showToast(error instanceof Error ? `保存失败:${error.message}` : '事件展示设置保存失败', { variant: 'danger' });
    }
  }

  function patchConfig(eventType: string, patch: Partial<EventDisplayConfig>): void {
    const base = current[eventType] ?? effective[eventType];
    if (!base) return;
    void persist({ ...current, [eventType]: { ...base, ...patch } });
  }

  function restoreDefault(eventType: string): void {
    if (!(eventType in current)) return;
    const next = { ...current };
    delete next[eventType];
    void persist(next);
  }

  return (
    <SettingsSection
      icon="i-lucide:bell"
      title="事件通知"
      description="控制工具、记忆、知识库和系统事件是否显示为本地通知。"
      trailing={(
        <div className="flex items-center gap-2">
          {apply && <SettingApplyBadge apply={apply} />}
          <SaveStateIndicator state={saveState} />
        </div>
      )}
    >
      <Callout variant="info" className="mb-4">
        “保持显示”的通知需要手动关闭。语音数据块和子 Agent 详情流属于高频内部事件，不列入通知设置。
      </Callout>

      <div className="flex flex-col gap-4">
        {EVENT_DISPLAY_GROUPS.map((group) => {
          const eventTypes = Object.keys(effective).filter(
            (eventType) => eventDisplayGroup(eventType) === group.id,
          );
          if (eventTypes.length === 0) return null;
          return (
            <div key={group.id} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ema-text-tertiary)]">
                {group.label}
              </h3>
              <SettingsCard>
                {eventTypes.map((eventType) => {
                  const config = current[eventType] ?? effective[eventType];
                  if (!config) return null;
                  return (
                    <EventRow
                      key={eventType}
                      eventType={eventType}
                      config={config}
                      overridden={eventType in current}
                      onPatch={(patch) => patchConfig(eventType, patch)}
                      onRestore={() => restoreDefault(eventType)}
                    />
                  );
                })}
              </SettingsCard>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function EventRow(props: {
  eventType: string;
  config: EventDisplayConfig;
  overridden: boolean;
  onPatch(patch: Partial<EventDisplayConfig>): void;
  onRestore(): void;
}): JSX.Element {
  const { eventType, config, overridden } = props;
  const durationValue = config.durationMs === null ? 'null' : String(config.durationMs);
  const durationOptions = DURATION_OPTIONS.some((option) => option.value === durationValue)
    ? DURATION_OPTIONS
    : [{ value: durationValue, label: `${config.durationMs} ms` }, ...DURATION_OPTIONS];
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-[var(--ema-text-primary)]">
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
          onCheckedChange={(enabled) => props.onPatch({ enabled })}
          label={`${eventDisplayLabel(eventType)}通知`}
        />

        <Select
          className="w-28"
          value={durationValue}
          options={durationOptions}
          disabled={!config.enabled}
          onChange={(value) => props.onPatch({
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
            onChange={(event) => props.onPatch({ color: event.target.value })}
          />
          <span className="font-mono text-[10px] text-[var(--ema-text-tertiary)]">{config.color}</span>
        </label>

        <Button
          variant="ghost"
          size="sm"
          disabled={!overridden}
          onClick={props.onRestore}
        >
          恢复默认
        </Button>
      </div>

      <TruncateField
        disabled={!config.enabled}
        value={config.truncateChars}
        onCommit={(truncateChars) => props.onPatch({ truncateChars })}
      />
    </div>
  );
}

/** 文本上限:本地草稿,失焦/回车提交;非法值回退并提示,不产生半保存状态。 */
function TruncateField({
  disabled, value, onCommit,
}: {
  disabled: boolean;
  value: number | undefined;
  onCommit(value: number | undefined): void;
}): JSX.Element {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => { setDraft(value === undefined ? '' : String(value)); }, [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      showToast('文本上限必须是 1 到 10000 之间的整数', { variant: 'danger' });
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <label className="mt-2 flex max-w-xs items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
      文本上限
      <Input
        inputSize="sm"
        type="number"
        min={1}
        max={10_000}
        disabled={disabled}
        value={draft}
        placeholder="不限"
        className="w-24"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
      />
      字符
    </label>
  );
}
