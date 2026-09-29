// 在外观页管理两个窗口的壁纸图库, 选图和单图参数.
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent, type CSSProperties } from 'react';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  FilePicker,
  PromptDialog,
  Switch,
  Tabs,
} from '@ema-agent/ui';
import type { MaterialMode, WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import {
  DEFAULT_WALLPAPER_IMAGE_PARAMS,
  DEFAULT_WALLPAPER_SETTINGS,
  WALLPAPER_SETTING_KEYS,
  type WallpaperWindowTarget,
} from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../../api/settings.js';
import { wallpaperApi, type WallpaperImageSummary } from '../../api/wallpaper.js';
import { ServerImage } from '../../lib/ServerImage.js';

const WINDOW_TABS = [
  { value: 'chat', label: '聊天窗口', content: null },
  { value: 'settings', label: '设置窗口', content: null },
];

const FILE_TYPES = '.png,.jpg,.jpeg,.webp';

const MATERIAL_TABS = [
  { value: 'translucent', label: '通透', content: null },
  { value: 'frosted', label: '磨砂', content: null },
];

interface PreviewFrame {
  readonly id: number;
  readonly target: WallpaperWindowTarget;
  readonly image: WallpaperImageSummary;
  readonly opacity: number;
  readonly blur: number;
  readonly transition: 'crossfade' | 'replace';
  readonly ready: boolean;
  readonly outgoing: boolean;
}

export function WallpaperTab(): JSX.Element {
  const [target, setTarget] = useState<WallpaperWindowTarget>('settings');
  const [displayTarget, setDisplayTarget] = useState<WallpaperWindowTarget>('settings');
  const [items, setItems] = useState<WallpaperImageSummary[]>([]);
  const [settings, setSettings] = useState<WallpaperSettings>(DEFAULT_WALLPAPER_SETTINGS);
  const [selectedName, setSelectedName] = useState('');
  const [opacity, setOpacity] = useState(35);
  const [blur, setBlur] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      wallpaperApi.listImages(target),
      settingsApi.getValue(WALLPAPER_SETTING_KEYS[target]),
    ]).then(([catalog, setting]) => {
      if (!mounted) return;
      const value = setting.value as WallpaperSettings;
      setDisplayTarget(target);
      setItems(catalog.items);
      setSettings(value);
      const active = catalog.items.find(item => item.name === value.activeImage);
      setSelectedName(active?.name ?? catalog.items[0]?.name ?? '');
    }).catch(cause => {
      if (mounted) setError(errorText(cause, '壁纸图库读取失败'));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [target]);

  useEffect(() => {
    const params = settings.images[selectedName] ?? DEFAULT_WALLPAPER_IMAGE_PARAMS;
    setOpacity(Math.round(params.opacity * 100));
    setBlur(params.blur);
  }, [selectedName, settings]);

  const selected = items.find(item => item.name === selectedName);
  const active = settings.activeImage === selectedName;
  const controlsDisabled = busy || loading || target !== displayTarget;
  const materialDisabled = controlsDisabled || !settings.enabled
    || !items.some(item => item.name === settings.activeImage);
  const materialHintVisible = !controlsDisabled && materialDisabled;
  const filenameBase = selected ? selected.name.slice(0, selected.name.lastIndexOf('.')) : '';

  async function saveSettings(next: WallpaperSettings): Promise<void> {
    const saved = await settingsApi.putValue(WALLPAPER_SETTING_KEYS[target], next);
    setSettings(saved.value as WallpaperSettings);
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause, '壁纸操作失败'));
    } finally {
      setBusy(false);
    }
  }

  function importFiles(files: File[]): void {
    void withBusy(async () => {
      const imported: WallpaperImageSummary[] = [];
      const failed: string[] = [];
      for (const file of files) {
        try {
          imported.push(await wallpaperApi.uploadImage(target, file));
        } catch {
          failed.push(file.name);
        }
      }
      const catalog = await wallpaperApi.listImages(target);
      setItems(catalog.items);
      if (imported.length === 0) {
        if (failed.length > 0) setError(`图片导入失败: ${failed.join(', ')}`);
        return;
      }
      const images = { ...settings.images };
      for (const image of imported) images[image.name] = DEFAULT_WALLPAPER_IMAGE_PARAMS;
      const firstImport = settings.activeImage === '';
      await saveSettings({
        ...settings,
        images,
        activeImage: firstImport ? imported[0]!.name : settings.activeImage,
        enabled: firstImport ? true : settings.enabled,
      });
      setSelectedName(imported[0]!.name);
      if (failed.length > 0) setError(`部分图片导入失败: ${failed.join(', ')}`);
    });
  }

  function setEnabled(enabled: boolean): void {
    void withBusy(() => saveSettings({ ...settings, enabled }));
  }

  function setMaterialMode(value: string): void {
    if (materialDisabled) return;
    void withBusy(() => saveSettings({ ...settings, materialMode: value as MaterialMode }));
  }

  function selectImage(name: string): void {
    const params = settings.images[name] ?? DEFAULT_WALLPAPER_IMAGE_PARAMS;
    setOpacity(Math.round(params.opacity * 100));
    setBlur(params.blur);
    setSelectedName(name);
  }

  function activateSelected(): void {
    if (!selected) return;
    void withBusy(() => saveSettings({ ...settings, enabled: true, activeImage: selected.name }));
  }

  function commitParam(field: 'opacity' | 'blur', value: number): void {
    if (!selected) return;
    const oldParams = settings.images[selected.name] ?? DEFAULT_WALLPAPER_IMAGE_PARAMS;
    const nextValue = field === 'opacity' ? value / 100 : value;
    if (oldParams[field] === nextValue) return;
    void withBusy(() => saveSettings({
      ...settings,
      images: {
        ...settings.images,
        [selected.name]: { ...oldParams, [field]: nextValue },
      },
    }));
  }

  function commitPointer(field: 'opacity' | 'blur', event: PointerEvent<HTMLInputElement>): void {
    commitParam(field, Number(event.currentTarget.value));
  }

  function commitKeyboard(field: 'opacity' | 'blur', event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
      commitParam(field, Number(event.currentTarget.value));
    }
  }

  function renameSelected(baseName: string): void {
    setRenameOpen(false);
    if (!selected) return;
    void withBusy(async () => {
      const renamed = await wallpaperApi.renameImage(target, selected.name, baseName);
      const images = { ...settings.images };
      const params = images[selected.name];
      delete images[selected.name];
      if (params) images[renamed.name] = params;
      await saveSettings({
        ...settings,
        images,
        activeImage: active ? renamed.name : settings.activeImage,
      });
      const catalog = await wallpaperApi.listImages(target);
      setItems(catalog.items);
      setSelectedName(renamed.name);
    });
  }

  function deleteSelected(): void {
    setDeleteOpen(false);
    if (!selected) return;
    void withBusy(async () => {
      await wallpaperApi.removeImage(target, selected.name);
      const catalog = await wallpaperApi.listImages(target);
      const remaining = catalog.items;
      const nextName = remaining.find(item => item.name > selected.name)?.name
        ?? remaining[0]?.name
        ?? '';
      const images = { ...settings.images };
      delete images[selected.name];
      await saveSettings({
        ...settings,
        images,
        activeImage: active ? nextName : settings.activeImage,
      });
      setItems(remaining);
      setSelectedName(active ? nextName : remaining[0]?.name ?? '');
    });
  }

  return (
    <section
      className="ema-material-section ema-wallpaper-controls space-y-5 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-5"
      onPointerDownCapture={event => { event.currentTarget.dataset.pointerFocus = 'true'; }}
      onKeyDownCapture={event => { delete event.currentTarget.dataset.pointerFocus; }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          delete event.currentTarget.dataset.pointerFocus;
        }
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-[var(--ema-text-secondary)]">窗口壁纸</h2>
          <p className="mt-0.5 text-xs text-[var(--ema-text-tertiary)]">
            每个窗口独立选择一张壁纸. 选中图片只编辑预览, 点击设为壁纸后才切换窗口背景.
          </p>
        </div>
        <FilePicker accept={FILE_TYPES} multiple disabled={controlsDisabled} onSelect={importFiles}>
          <Button icon="i-lucide:images" size="sm" disabled={controlsDisabled}>批量导入</Button>
        </FilePicker>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={target}
          onChange={value => { if (!busy) setTarget(value as WallpaperWindowTarget); }}
          items={WINDOW_TABS}
          variant="pill"
          triggersOnly
          className="w-64 max-w-full"
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[var(--ema-text-secondary)]">
          <div className="flex flex-col gap-1" aria-label="窗口界面材质">
            <div className="flex items-center gap-2">
              <span>界面材质</span>
              <Tabs
                value={settings.materialMode}
                onChange={setMaterialMode}
                items={MATERIAL_TABS.map(item => ({ ...item, disabled: materialDisabled }))}
                variant="pill"
                triggersOnly
                className="w-32"
              />
            </div>
            <span
              className={`block h-4 whitespace-nowrap text-[var(--ema-text-tertiary)] ${materialHintVisible ? '' : 'invisible'}`}
              aria-hidden={!materialHintVisible}
            >
              {settings.enabled ? '设为壁纸后生效' : '开启壁纸后生效'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span>在此窗口显示壁纸</span>
            <Switch checked={settings.enabled} onCheckedChange={setEnabled} disabled={controlsDisabled || items.length === 0} label="显示壁纸" />
          </div>
        </div>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {loading && items.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-[var(--ema-text-tertiary)]">读取图库中...</div>
      ) : items.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--ema-border)] text-[var(--ema-text-tertiary)]">
          <span className="i-lucide:image-plus text-3xl" aria-hidden />
          <span className="text-sm">还没有壁纸. 导入 PNG, JPG 或 WebP 图片开始.</span>
        </div>
      ) : selected && (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(16rem,1fr)]">
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-bg)]">
              <WallpaperPreview target={displayTarget} image={selected} opacity={opacity / 100} blur={blur} />
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <div>
                <p className="text-xs text-[var(--ema-text-tertiary)]">文件名称</p>
                <p className="mt-1 break-all text-sm font-medium text-[var(--ema-text-primary)]">{selected.name}</p>
                <p className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
                  {formatBytes(selected.size)} · 修改于 {new Date(selected.modifiedAt).toLocaleString('zh-CN')}
                </p>
              </div>

              <div className="space-y-3">
                <label className="block text-xs text-[var(--ema-text-secondary)]" htmlFor="wallpaper-opacity">
                  <span className="flex justify-between"><span>不透明度</span><span>{opacity}%</span></span>
                </label>
                <input
                  id="wallpaper-opacity"
                  type="range"
                  className="ema-wallpaper-range"
                  min={0}
                  max={100}
                  value={opacity}
                  disabled={controlsDisabled}
                  onChange={event => setOpacity(Number(event.target.value))}
                  onPointerUp={event => commitPointer('opacity', event)}
                  onKeyUp={event => commitKeyboard('opacity', event)}
                />
              </div>

              <div className="space-y-3">
                <label className="block text-xs text-[var(--ema-text-secondary)]" htmlFor="wallpaper-blur">
                  <span className="flex justify-between"><span>壁纸模糊</span><span>{blur}px</span></span>
                </label>
                <input
                  id="wallpaper-blur"
                  type="range"
                  className="ema-wallpaper-range"
                  min={0}
                  max={40}
                  value={blur}
                  disabled={controlsDisabled}
                  onChange={event => setBlur(Number(event.target.value))}
                  onPointerUp={event => commitPointer('blur', event)}
                  onKeyUp={event => commitKeyboard('blur', event)}
                />
              </div>

              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                {active ? (
                  <Badge variant="primary" className="ema-wallpaper-action-badge rounded-md px-3 py-1.5">已设为壁纸</Badge>
                ) : (
                  <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={activateSelected}>设为壁纸</Button>
                )}
                <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={() => setRenameOpen(true)}>改名</Button>
                <Button variant="danger" size="sm" disabled={controlsDisabled} onClick={() => setDeleteOpen(true)}>删除</Button>
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs text-[var(--ema-text-tertiary)]">图库 · {items.length} 张</p>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {items.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  disabled={controlsDisabled}
                  aria-pressed={item.name === selectedName}
                  title={item.name}
                  onClick={() => selectImage(item.name)}
                  className={`ema-wallpaper-thumbnail group relative w-28 shrink-0 overflow-hidden rounded-lg border text-left ${
                    item.name === selectedName
                      ? 'border-[var(--ema-primary)] shadow-[var(--ema-shadow-soft)]'
                      : 'border-[var(--ema-border)] hover:border-[var(--ema-primary)]/60'
                  }`}
                >
                  <div className="h-18 bg-[var(--ema-surface-2)] ema-fade-in">
                    <ServerImage
                      path={wallpaperApi.thumbnailPath(displayTarget, item.name)}
                      contentUpdatedAt={item.modifiedAt}
                      alt=""
                      className="h-full w-full object-cover "
                    />
                  </div>
                  <span className="block truncate px-2 py-1 text-[11px] text-[var(--ema-text-secondary)]">{item.name}</span>
                  {item.name === settings.activeImage && (
                    <Badge variant="primary" className="ema-wallpaper-thumbnail-badge absolute right-1 top-1 rounded-md px-1.5 py-0.5 text-[10px]">
                      使用中
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <PromptDialog
        open={renameOpen}
        title="重命名壁纸"
        message="只修改文件名, 扩展名保持不变. 同名会自动追加 (1), (2)."
        initialValue={filenameBase}
        onConfirm={renameSelected}
        onCancel={() => setRenameOpen(false)}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除壁纸"
        message={`确定删除 ${selected?.name ?? '这张壁纸'}? 文件会从图库移除.`}
        onConfirm={deleteSelected}
        onCancel={() => setDeleteOpen(false)}
      />
    </section>
  );
}

function WallpaperPreview({
  target,
  image,
  opacity,
  blur,
}: {
  target: WallpaperWindowTarget;
  image: WallpaperImageSummary;
  opacity: number;
  blur: number;
}): JSX.Element {
  const [frames, setFrames] = useState<PreviewFrame[]>([
    { id: 0, target, image, opacity, blur, transition: 'crossfade', ready: false, outgoing: false },
  ]);
  const currentKey = useRef(`${target}/${image.name}/${image.modifiedAt}`);
  const currentTarget = useRef(target);
  const nextFrameId = useRef(0);
  const retirementTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const key = `${target}/${image.name}/${image.modifiedAt}`;
    if (currentKey.current === key) {
      setFrames(previous => previous.map(frame => {
        if (frame.id !== nextFrameId.current || (frame.opacity === opacity && frame.blur === blur)) return frame;
        return { ...frame, opacity, blur };
      }));
      return;
    }
    const transition = currentTarget.current === target ? 'crossfade' : 'replace';
    currentKey.current = key;
    currentTarget.current = target;
    const id = ++nextFrameId.current;
    setFrames(previous => [
      ...previous.filter(frame => frame.ready && !frame.outgoing),
      { id, target, image, opacity, blur, transition, ready: false, outgoing: false },
    ]);
  }, [target, image.name, image.modifiedAt, opacity, blur]);

  useEffect(() => () => {
    for (const timer of retirementTimers.current) clearTimeout(timer);
  }, []);

  function markReady(id: number): void {
    if (id !== nextFrameId.current) return;
    const incoming = frames.find(frame => frame.id === id);
    if (!incoming) return;
    // 切换配置对象时完整替换预览, 不让两张图同时淡向透明而露出底面.
    if (incoming.transition === 'replace') {
      for (const timer of retirementTimers.current) clearTimeout(timer);
      retirementTimers.current.clear();
      setFrames([{ ...incoming, ready: true }]);
      return;
    }
    setFrames(previous => previous.map(frame => {
      if (frame.id === id) return { ...frame, ready: true };
      return frame.ready ? { ...frame, outgoing: true } : frame;
    }));
    const timer = setTimeout(() => {
      retirementTimers.current.delete(timer);
      setFrames(previous => previous.filter(frame => !frame.outgoing));
    }, 340);
    retirementTimers.current.add(timer);
  }

  return (
    <>
      {frames.map(frame => {
        const visibility = frame.ready ? 'active' : 'pending';
        return (
        <div
          key={frame.id}
          className="ema-wallpaper-preview-frame absolute inset-0"
          data-state={frame.outgoing ? 'outgoing' : visibility}
          data-transition={frame.transition}
        >
          <div
            className="absolute inset-0"
            style={{
              opacity: frame.opacity,
              filter: `blur(${frame.blur}px)`,
              transform: `scale(${1 + frame.blur / 100})`,
            }}
          >
            <ServerImage
              path={wallpaperApi.imagePath(frame.target, frame.image.name)}
              contentUpdatedAt={frame.image.modifiedAt}
              alt={frame.image.name}
              className="h-full w-full object-cover"
              onLoad={() => markReady(frame.id)}
            />
          </div>
        </div>
        );
      })}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
