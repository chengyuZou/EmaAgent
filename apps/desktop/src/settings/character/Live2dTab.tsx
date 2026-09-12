// 展示角色的 Live2D 模型卡片，并承接导入、封面和资源级操作。
import { useState, type JSX } from 'react';
import {
  Button,
  DropdownMenu,
  ScrollArea,
  type MenuItem,
} from '@ema-agent/ui';
import { ServerApiError } from '../../api/client.js';
import { charactersApi, type Character } from '../../api/characters.js';
import { renderLive2dPreview } from '../../lib/live2dPreview.js';
import { ServerImage } from '../../lib/ServerImage.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useCharacterStore } from '../../stores/character.js';
import { Live2dModelConfiguration } from './Live2dModelConfiguration.js';

type Live2dModel = Character['live2dModels'][number];

async function generateLive2dPreview(characterName: string, live2dName: string): Promise<void> {
  const archive = await charactersApi.live2dArchive(characterName, live2dName);
  const base64 = await renderLive2dPreview(archive);
  await charactersApi.uploadLive2dPreview(characterName, live2dName, base64);
}

export function Live2dTab({ character }: { character: Character }): JSX.Element {
  const models = character.live2dModels;
  const primaryModel = models.find(model => model.isPrimary);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
        <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">Live2D</h3>
        <ImportMenu character={character} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-5 pb-5">
          {models.length === 0 && (
            <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">
              还没有 Live2D 模型,点右上角导入
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {models.map((model, index) => (
              <ModelCard
                key={model.name}
                character={character}
                model={model}
                index={index}
              />
            ))}
          </div>
          {character.isActive && primaryModel && (
            <Live2dModelConfiguration
              key={`${character.name}/${primaryModel.name}`}
              character={character}
              model={primaryModel}
            />
          )}
          {!character.isActive && primaryModel && (
            <p className="py-4 text-center text-xs text-[var(--ema-text-tertiary)]">
              只有当前角色的主要 Live2D 可以调试表情和动作
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ModelCard({
  character,
  model,
  index,
}: {
  character: Character;
  model: Live2dModel;
  index: number;
}): JSX.Element {
  const store = useCharacterStore();
  const [missing, setMissing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationFailed, setGenerationFailed] = useState(false);
  const [imageKey, setImageKey] = useState(0);

  async function renderPreview(): Promise<void> {
    setGenerating(true);
    setGenerationFailed(false);
    try {
      await generateLive2dPreview(character.name, model.name);
      setMissing(false);
      setImageKey(value => value + 1);
      showToast('封面已生成', { variant: 'success' });
    } catch (error) {
      setGenerationFailed(true);
      showToast(error instanceof Error ? error.message : '封面生成失败', { variant: 'danger' });
    } finally {
      setGenerating(false);
    }
  }

  const menuItems: MenuItem[] = [
    {
      kind: 'item',
      label: model.isPrimary ? '主要模型' : '设为主要模型',
      icon: 'i-solar:star-bold-duotone',
      disabled: model.isPrimary,
      onSelect: () => {
        void store.setPrimaryLive2d(character.name, model.name)
          .catch((error) => {
            if (error instanceof ServerApiError && error.code === 'character_work_running') {
              showToast('Session 活跃期间不能切换主要 Live2D', { variant: 'warning' });
              return;
            }
            showToast(error instanceof Error ? error.message : '设置失败', { variant: 'danger' });
          });
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '重新渲染封面',
      icon: generating ? 'i-solar:refresh-bold animate-spin' : 'i-solar:refresh-bold',
      disabled: generating,
      onSelect: () => {
        void renderPreview();
      },
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: '打开文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void charactersApi.live2dLocation(character.name, model.name)
          .then(({ path }) => charactersApi.openDirectory(path))
          .catch(() => showToast('打开文件夹失败', { variant: 'danger' }));
      },
    },
    {
      kind: 'item',
      label: '导出',
      icon: 'i-solar:download-minimalistic-bold-duotone',
      onSelect: () => {
        void exportLive2d(character.name, model.name);
      },
    },
    {
      kind: 'item',
      label: '永久删除',
      icon: 'i-solar:trash-bin-trash-bold-duotone',
      onSelect: () => {
        void store.deleteLive2d(character.name, model.name)
          .then(() => showToast('已删除模型', { variant: 'success' }))
          .catch((error) => {
            if (error instanceof ServerApiError && error.code === 'character_work_running') {
              showToast('Session 活跃期间不能删除角色资源', { variant: 'warning' });
              return;
            }
            showToast(error instanceof Error ? error.message : '删除失败', { variant: 'danger' });
          });
      },
    },
  ];

  return (
    <div
      className={`ema-stagger-in group relative overflow-hidden rounded-xl border
        transition-all duration-[var(--ema-duration-base)] hover:-translate-y-0.5
        hover:shadow-[var(--ema-shadow-soft)]
        ${model.isPrimary
          ? 'border-[var(--ema-primary)] shadow-[var(--ema-shadow-1)]'
          : 'border-[var(--ema-border)] bg-[var(--ema-surface-2)]'}`}
      style={{ '--stagger-i': index } as React.CSSProperties}
    >
      <div className="absolute left-2 top-2 z-10">
        <span
          className={`block h-4 w-4 rounded-full border-2
            ${model.isPrimary
              ? 'border-[var(--ema-success)] bg-[var(--ema-success)]'
              : 'border-[var(--ema-text-tertiary)] bg-transparent'}`}
          title={model.isPrimary ? '主要模型' : '非主要模型'}
        />
      </div>
      <div className="absolute right-2 top-2 z-10" onClick={event => event.stopPropagation()}>
        <DropdownMenu
          side="bottom"
          align="end"
          items={menuItems}
          trigger={(
            <button
              type="button"
              aria-label="更多操作"
              className="inline-flex h-6 w-6 cursor-pointer select-none items-center justify-center rounded-md text-sm text-[var(--ema-text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100"
            >
              ⋯
            </button>
          )}
        />
      </div>
      {missing ? (
        <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 bg-[var(--ema-surface-3)] px-3 text-center">
          <span className="text-xs text-[var(--ema-text-tertiary)]">
            {generationFailed ? '封面生成失败' : '暂无封面'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            loading={generating}
            onClick={(event) => {
              event.stopPropagation();
              void renderPreview();
            }}
          >
            {generating ? '正在生成' : '生成封面'}
          </Button>
        </div>
      ) : (
        <ServerImage
          key={imageKey}
          path={charactersApi.live2dPreviewUrl(character.name, model.name)}
          alt={model.name}
          className="aspect-[3/4] w-full object-cover"
          onMissing={() => setMissing(true)}
        />
      )}
      <div className="px-3 py-2">
        <p className="truncate text-xs font-semibold text-[var(--ema-text-primary)]">{model.name}</p>
        <p className="truncate text-[11px] text-[var(--ema-text-tertiary)]">{model.displayName}</p>
        <p className="mt-1 text-[10px] text-[var(--ema-text-tertiary)]">
          {formatBytes(model.byteSize)}
        </p>
      </div>
    </div>
  );
}

async function exportLive2d(characterName: string, live2dName: string): Promise<void> {
  const destination = await tauriBridge.openFileDialog({ directory: true });
  if (!destination) return;
  try {
    await charactersApi.exportLive2d(characterName, live2dName, destination);
    showToast('已导出', { variant: 'success' });
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导出失败', { variant: 'danger' });
  }
}

function ImportMenu({ character }: { character: Character }): JSX.Element {
  const store = useCharacterStore();
  const [importing, setImporting] = useState<'model' | 'preview' | null>(null);

  async function runImport(source: string): Promise<void> {
    setImporting('model');
    try {
      const result = await charactersApi.importLive2d(character.name, { source });
      setImporting('preview');
      let previewError: string | null = null;
      try {
        await generateLive2dPreview(character.name, result.name);
      } catch (error) {
        previewError = error instanceof Error ? error.message : '未知错误';
      }
      await store.load();
      if (previewError) {
        showToast(`${result.name} 已导入,但封面生成失败: ${previewError}`, { variant: 'warning' });
      } else {
        showToast(`已导入 ${result.name}`, { variant: 'success' });
      }
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'character_work_running') {
        showToast('当前角色有正在执行的任务,请先停止或等其结束后再导入', { variant: 'warning' });
        return;
      }
      showToast(error instanceof Error ? error.message : '导入失败', { variant: 'danger' });
    } finally {
      setImporting(null);
    }
  }

  const items: MenuItem[] = [
    {
      kind: 'item',
      label: '导入 ZIP 包',
      icon: 'i-lucide:package',
      onSelect: () => {
        void selectLive2dArchive(runImport);
      },
    },
    {
      kind: 'item',
      label: '导入文件夹',
      icon: 'i-solar:folder-open-bold-duotone',
      onSelect: () => {
        void selectLive2dDirectory(runImport);
      },
    },
  ];

  return (
    <DropdownMenu
      side="bottom"
      align="end"
      items={items}
      trigger={(
        <Button variant="primary" size="sm" icon="i-mdi:plus" loading={importing !== null}>
          {importing === 'preview' ? '正在生成封面' : '导入'}
        </Button>
      )}
    />
  );
}

async function selectLive2dArchive(importModel: (source: string) => Promise<void>): Promise<void> {
  const source = await tauriBridge.openFileDialog({
    filters: [{ name: 'Live2D ZIP', extensions: ['zip'] }],
  });
  if (source) await importModel(source);
}

async function selectLive2dDirectory(importModel: (source: string) => Promise<void>): Promise<void> {
  const source = await tauriBridge.openFileDialog({ directory: true });
  if (source) await importModel(source);
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
