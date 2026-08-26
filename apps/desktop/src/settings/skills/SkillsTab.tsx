// 技能管理主装配:已安装与市场两个页签、卸载确认。
// 市场视图与已安装列表各自成文件,这里只取数与拼块。
import { useEffect, useState, type JSX } from 'react';
import { Callout, ConfirmDialog, Tabs } from '@ema-agent/ui';
import { useSkillStore } from '../../stores/skill-store.js';
import { showToast } from '../../lib/toast.js';
import { SkillMarketView } from './SkillMarketView.js';
import { SkillInstalledList } from './SkillInstalledList.js';

export function SkillsTab(): JSX.Element {
  const skills      = useSkillStore((s) => s.skills);
  const error       = useSkillStore((s) => s.error);

  const [activeTab,    setActiveTab]    = useState<string>('installed');
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  useEffect(() => { void useSkillStore.getState().load(); }, []);

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const key = pendingRemove;
    setPendingRemove(null);
    try {
      await useSkillStore.getState().remove(key);
      showToast(`已卸载 ${key}`, { variant: 'success' });
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const tabItems = [
    {
      value:   'installed',
      label:   `已安装 (${skills.length})`,
      content: <SkillInstalledList onRemove={setPendingRemove} />,
    },
    {
      value:   'market',
      label:   '浏览市场',
      content: <SkillMarketView active={activeTab === 'market'} />,
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
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        variant="underline"
      />

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定卸载技能 "${pendingRemove}"？` : ''}
        confirmText="卸载"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
