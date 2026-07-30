// 技能管理主装配:已安装与市场两个页签、安装方式入口、卸载与重命名确认。
// 市场视图、已安装列表与安装/重命名对话框各自成文件,这里只取数与拼块。
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, ConfirmDialog, Tabs } from '@ema-agent/ui';
import { useSkillStore } from '../../stores/skill-store.js';
import type { GithubSkillCoords } from '@ema-agent/skills';
import { showToast } from '../../lib/toast.js';
import { SkillMarketView } from './SkillMarketView.js';
import { SkillInstalledList } from './SkillInstalledList.js';
import {
  SkillRenameDialog,
  SkillTextInstallDialog,
  SkillUrlInstallDialog,
} from './SkillInstallDialogs.js';

type InstallMode = 'text' | 'url' | null;

export function SkillsTab(): JSX.Element {
  const skills      = useSkillStore((s) => s.skills);
  const error       = useSkillStore((s) => s.error);

  const [installMode,  setInstallMode]  = useState<InstallMode>(null);
  const [activeTab,    setActiveTab]    = useState<string>('installed');
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingRename, setPendingRename] = useState<string | null>(null);

  useEffect(() => { void useSkillStore.getState().load(); }, []);

  // 市场卡片安装:不经对话框,coords/sha256 来自市场清单;失败必须 toast 可见。
  async function handleMarketInstall(
    url: string,
    coords?: GithubSkillCoords,
    sha256?: string,
  ): Promise<void> {
    try {
      const sk = await useSkillStore.getState().installFromUrl(url, coords, sha256);
      showToast(`已安装 ${sk.name}`, { variant: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`安装失败: ${msg}`, { variant: 'danger' });
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    try {
      await useSkillStore.getState().remove(name);
      showToast(`已卸载 ${name}`, { variant: 'success' });
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const installedNames = new Set(skills.map((s) => s.name));

  const tabItems = [
    {
      value:   'installed',
      label:   `已安装 (${skills.length})`,
      content: <SkillInstalledList onRemove={setPendingRemove} onRename={setPendingRename} />,
    },
    {
      value:   'market',
      label:   '浏览市场',
      content: (
        <SkillMarketView
          active={activeTab === 'market'}
          installedNames={installedNames}
          onInstall={(url, _name, coords, sha256) => handleMarketInstall(url, coords, sha256)}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">技能管理</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">安装并管理自定义技能(Markdown 驱动，含工具权限白名单)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setInstallMode('url')}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            从 URL 安装
          </Button>
          <Button variant="primary" size="sm" onClick={() => setInstallMode('text')}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            从文本安装
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        variant="underline"
      />

      <SkillTextInstallDialog
        open={installMode === 'text'}
        onOpenChange={(open) => { if (!open) setInstallMode(null); }}
      />
      <SkillUrlInstallDialog
        open={installMode === 'url'}
        onOpenChange={(open) => { if (!open) setInstallMode(null); }}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定卸载技能 "${pendingRemove}"？` : ''}
        confirmText="卸载"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />

      {/* key 区分重命名目标,切换时重挂让输入框重置为该技能现名。 */}
      <SkillRenameDialog
        key={pendingRename ?? 'closed'}
        name={pendingRename}
        onOpenChange={(open) => { if (!open) setPendingRename(null); }}
      />
    </div>
  );
}
