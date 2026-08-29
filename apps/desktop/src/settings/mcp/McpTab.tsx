// MCP 服务器设置主装配:已配置列表与市场浏览两个页签、启停与移除、对话框挂载。
// 市场视图、服务器行与两个对话框各自成文件,这里只取数与拼块。
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import {
  Button, Callout, ConfirmDialog, EmptyState, ScrollArea, Spinner, Tabs,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpServerItem } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';
import { McpMarketView } from './McpMarketView.js';
import { ServerRow } from './McpServerRow.js';
import { McpImportDialog, McpServerFormDialog } from './McpServerDialogs.js';

export function McpTab(): JSX.Element {
  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const error   = useMcpStore((s) => s.error);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const [activeTab, setActiveTab] = useState('installed');
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  useEffect(() => { void useMcpStore.getState().load(); }, []);

  const installedRegistryEntries = new Set(
    servers.flatMap((server) => server.provenance.sourceKind === 'registry'
      ? [`${server.provenance.registrySourceId}:${server.provenance.registryEntryId}`]
      : []),
  );

  function handleEdit(sv: McpServerItem): void {
    setEditing(sv);
    setAddOpen(true);
  }

  async function handleToggleEnabled(sv: McpServerItem): Promise<void> {
    try {
      if (sv.enabled) {
        await useMcpStore.getState().disable(sv.name);
      } else {
        await useMcpStore.getState().enable(sv.name);
      }
    } catch (err) {
      showToast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    try {
      await useMcpStore.getState().remove(name);
      showToast(`已移除 ${name}`, { variant: 'success' });
    } catch (err) {
      showToast(`移除失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">MCP 服务器</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">连接模型上下文协议(MCP)服务器，扩展 Agent 的工具集</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            <span className="i-mdi:code-json text-base" aria-hidden />
            从 JSON 导入
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setEditing(null); setAddOpen(true); }}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            <span className="i-mdi:plus text-base" aria-hidden />
            添加服务器
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        variant="underline"
        items={[
          {
            value: 'installed',
            label: `已配置 (${servers.length})`,
            content: (
              <>
                {loading && (
                  <div className="flex justify-center py-10"><Spinner size="md" /></div>
                )}
                {!loading && servers.length === 0 && (
                  <EmptyState icon="i-mdi:server-outline" title="暂无 MCP 服务器" hint='点击"添加服务器"或到「浏览市场」挑选' animate className="py-16" />
                )}
                {!loading && servers.length > 0 && (
                  <ScrollArea className="flex-1" viewportClassName="pb-2">
                    <div className="flex flex-col gap-2 pr-2">
                      {servers.map((sv, i) => (
                        <div key={sv.name} className="ema-stagger-in" style={{ '--stagger-i': i } as CSSProperties}>
                          <ServerRow
                            server={sv}
                            onToggleEnabled={() => void handleToggleEnabled(sv)}
                            onRemove={() => setPendingRemove(sv.name)}
                            onEdit={() => handleEdit(sv)}
                          />
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </>
            ),
          },
          {
            value: 'market',
            label: '浏览市场',
            content: (
              <McpMarketView
                active={activeTab === 'market'}
                installedRegistryEntries={installedRegistryEntries}
              />
            ),
          },
        ]}
      />

      <McpImportDialog open={importOpen} onOpenChange={setImportOpen} />
      {/* key 区分新建/编辑实例,切换时整体重挂让表单重置到对应初值。 */}
      <McpServerFormDialog
        key={editing?.name ?? 'new'}
        open={addOpen}
        editing={editing}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setEditing(null);
        }}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定移除 MCP 服务器 "${pendingRemove}"？` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
