// 渲染后端设置目录中的一个参数域，并用目录 schema 选择对应输入控件。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Callout, Input, Select, Switch, Textarea } from '@ema-agent/ui';
import type { SettingsCatalogItem } from '../../api/settings.js';
import { showToast } from '../../lib/toast.js';
import {
  SaveStateIndicator,
  SettingItem,
  SettingsCard,
  SettingsSection,
} from '../shared/SettingItem.js';
import type { SettingDomain } from './settingCatalog.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

const APPLY_LABELS = {
  immediate: '立即生效',
  nextOperation: '下次操作生效',
  nextTurn: '下一轮生效',
  restart: '重启后生效',
} as const;

export function SettingCatalogPage({
  domain,
  values,
  onSave,
  onReset,
}: {
  domain: SettingDomain;
  values: ReadonlyMap<string, unknown>;
  onSave(key: string, value: unknown): Promise<void>;
  onReset(item: SettingsCatalogItem): Promise<void>;
}): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 pb-10">
      <header>
        <div className="flex items-center gap-3">
          <span className={`${domain.icon} text-2xl text-[var(--ema-text-tertiary)]`} aria-hidden />
          <div>
            <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">{domain.label}</h1>
            <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
              参数名称、说明、范围与生效时机均来自后端设置目录。
            </p>
          </div>
        </div>
      </header>

      {domain.sections.map((section) => (
        <SettingsSection
          key={section.id}
          icon="i-lucide:sliders-horizontal"
          title={section.label}
          description={section.id === 'general' ? `${domain.label} 的直接参数` : `${section.label}相关参数`}
        >
          <SettingsCard>
            {section.items.map((item) => (
              <CatalogSettingRow
                key={item.key}
                item={item}
                value={values.has(item.key) ? values.get(item.key) : item.defaultValue}
                onSave={onSave}
                onReset={onReset}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
    </div>
  );
}

export function SettingSearchResults({
  query,
  items,
  values,
  onSave,
  onReset,
}: {
  query: string;
  items: readonly SettingsCatalogItem[];
  values: ReadonlyMap<string, unknown>;
  onSave(key: string, value: unknown): Promise<void>;
  onReset(item: SettingsCatalogItem): Promise<void>;
}): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pb-10">
      <header>
        <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">搜索设置</h1>
        <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
          “{query}”共找到 {items.length} 个参数
        </p>
      </header>
      {items.length === 0 ? (
        <Callout variant="info">没有匹配的设置。可以搜索名称、说明或完整 key。</Callout>
      ) : (
        <SettingsCard>
          {items.map((item) => (
            <CatalogSettingRow
              key={item.key}
              item={item}
              value={values.has(item.key) ? values.get(item.key) : item.defaultValue}
              onSave={onSave}
              onReset={onReset}
              showKey
            />
          ))}
        </SettingsCard>
      )}
    </div>
  );
}

function CatalogSettingRow({
  item,
  value,
  onSave,
  onReset,
  showKey = false,
}: {
  item: SettingsCatalogItem;
  value: unknown;
  onSave(key: string, value: unknown): Promise<void>;
  onReset(item: SettingsCatalogItem): Promise<void>;
  showKey?: boolean;
}): JSX.Element {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const isDefault = useMemo(
    () => JSON.stringify(value) === JSON.stringify(item.defaultValue),
    [item.defaultValue, value],
  );

  async function save(next: unknown): Promise<void> {
    setSaveState('saving');
    try {
      await onSave(item.key, next);
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_200);
    } catch (cause: unknown) {
      setSaveState('failed');
      showToast(cause instanceof Error ? `保存失败：${cause.message}` : '设置保存失败', { variant: 'danger' });
    }
  }

  async function reset(): Promise<void> {
    setSaveState('saving');
    try {
      await onReset(item);
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_200);
    } catch (cause: unknown) {
      setSaveState('failed');
      showToast(cause instanceof Error ? `恢复失败：${cause.message}` : '恢复默认失败', { variant: 'danger' });
    }
  }

  const hint = showKey ? `${item.description} · ${item.key}` : item.description;
  return (
    <SettingItem title={item.label} hint={hint}>
      <span className="hidden xl:inline text-[10px] text-[var(--ema-text-tertiary)]">
        {APPLY_LABELS[item.apply]}
      </span>
      <SaveStateIndicator state={saveState} />
      <SettingValueControl item={item} value={value} disabled={saveState === 'saving'} onCommit={save} />
      <Button
        variant="ghost"
        size="sm"
        disabled={isDefault || saveState === 'saving'}
        onClick={() => void reset()}
        title="恢复默认值"
      >
        <span className="i-lucide:rotate-ccw text-sm" aria-hidden />
      </Button>
    </SettingItem>
  );
}

function SettingValueControl({
  item,
  value,
  disabled,
  onCommit,
}: {
  item: SettingsCatalogItem;
  value: unknown;
  disabled: boolean;
  onCommit(value: unknown): Promise<void>;
}): JSX.Element {
  const schema = editableSchema(item.schema);
  const kind = schemaType(schema);
  const choices = stringArray(schemaValue(schema, 'enum'));

  if (kind === 'boolean') {
    return (
      <Switch
        checked={value === true}
        disabled={disabled}
        label={item.label}
        onCheckedChange={(checked) => void onCommit(checked)}
      />
    );
  }

  if (kind === 'number' || kind === 'integer') {
    return (
      <NumberSettingInput
        value={typeof value === 'number' ? value : null}
        nullable={schemaAllowsNull(item.schema)}
        integer={kind === 'integer'}
        min={numberValue(schemaValue(schema, 'minimum'))}
        max={numberValue(schemaValue(schema, 'maximum'))}
        disabled={disabled}
        onCommit={onCommit}
      />
    );
  }

  if (kind === 'string' && choices.length > 0) {
    return (
      <Select
        className="w-52"
        value={typeof value === 'string' ? value : undefined}
        disabled={disabled}
        onChange={(next) => void onCommit(next)}
        options={choices.map((choice) => ({ value: choice, label: choice }))}
      />
    );
  }

  if (kind === 'string') {
    return (
      <TextSettingInput
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onCommit={onCommit}
      />
    );
  }

  if (kind === 'array' && schemaType(schemaValue(schema, 'items')) === 'string') {
    return (
      <StringListSettingInput
        value={Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []}
        disabled={disabled}
        onCommit={onCommit}
      />
    );
  }

  return <JsonSettingInput value={value} disabled={disabled} onCommit={onCommit} />;
}

function NumberSettingInput({
  value,
  nullable,
  integer,
  min,
  max,
  disabled,
  onCommit,
}: {
  value: number | null;
  nullable: boolean;
  integer: boolean;
  min?: number;
  max?: number;
  disabled: boolean;
  onCommit(value: number | null): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);

  function commit(): void {
    const trimmed = draft.trim();
    if (!trimmed && nullable) {
      void onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? '' : String(value));
      return;
    }
    const rounded = integer ? Math.round(parsed) : parsed;
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, rounded));
    setDraft(String(bounded));
    if (bounded !== value) void onCommit(bounded);
  }

  return (
    <Input
      className="w-36"
      inputSize="sm"
      type="number"
      value={draft}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={nullable ? '留空 = 不限' : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function TextSettingInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit(value: string): Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      className="w-64"
      inputSize="sm"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) void onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function StringListSettingInput({
  value,
  disabled,
  onCommit,
}: {
  value: readonly string[];
  disabled: boolean;
  onCommit(value: readonly string[]): Promise<void>;
}): JSX.Element {
  const serialized = value.join('\n');
  const [draft, setDraft] = useState(serialized);
  useEffect(() => setDraft(serialized), [serialized]);
  return (
    <Textarea
      className="w-72 font-mono text-xs"
      minRows={2}
      maxRows={6}
      value={draft}
      disabled={disabled}
      placeholder="每行一项"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
        if (JSON.stringify(next) !== JSON.stringify(value)) void onCommit(next);
      }}
    />
  );
}

function JsonSettingInput({
  value,
  disabled,
  onCommit,
}: {
  value: unknown;
  disabled: boolean;
  onCommit(value: unknown): Promise<void>;
}): JSX.Element {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(serialized);
    setInvalid(false);
  }, [serialized]);
  return (
    <Textarea
      className="w-80 font-mono text-xs"
      minRows={3}
      maxRows={8}
      value={draft}
      disabled={disabled}
      error={invalid}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        try {
          const next: unknown = JSON.parse(draft);
          setInvalid(false);
          if (JSON.stringify(next) !== JSON.stringify(value)) void onCommit(next);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

function editableSchema(schema: unknown): unknown {
  const variants = unknownArray(schemaValue(schema, 'anyOf'));
  return variants.find((variant) => schemaType(variant) !== 'null') ?? schema;
}

function schemaAllowsNull(schema: unknown): boolean {
  if (schemaType(schema) === 'null') return true;
  return unknownArray(schemaValue(schema, 'anyOf')).some((variant) => schemaType(variant) === 'null');
}

function schemaType(schema: unknown): string | undefined {
  const type = schemaValue(schema, 'type');
  return typeof type === 'string' ? type : undefined;
}

function schemaValue(schema: unknown, key: string): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined;
  return Reflect.get(schema, key);
}

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
