import { useState, type CSSProperties, type JSX } from 'react';
import {
  Button, Callout, ConfirmDialog, EmptyState, ScrollArea, Spinner,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpServerItem } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';
import { ServerRow } from './McpServerRow.js';
import { McpImportDialog, McpServerFormDialog } from './McpServerDialogs.js';

export function McpServersPage(): JSX.Element {
  const servers = useMcpStore((state) => state.servers);
  const loading = useMcpStore((state) => state.loading);
  const error = useMcpStore((state) => state.error);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  function handleEdit(server: McpServerItem): void {
    setEditing(server);
    setAddOpen(true);
  }

  async function handleToggleEnabled(server: McpServerItem): Promise<void> {
    try {
      if (server.enabled) {
        await useMcpStore.getState().disable(server.name);
      } else {
        await useMcpStore.getState().enable(server.name);
      }
    } catch (error) {
      showToast(`操作失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    try {
      await useMcpStore.getState().remove(name);
      showToast(`已移除 ${name}`, { variant: 'success' });
    } catch (error) {
      showToast(`移除失败: ${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">已配置</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
            管理 MCP 服务器并独立查看每个服务器的连接状态与工具.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setImportOpen(true)}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]"
          >
            <span className="i-mdi:code-json text-base" aria-hidden />
            从 JSON 导入
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setEditing(null); setAddOpen(true); }}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]"
          >
            <span className="i-mdi:plus text-base" aria-hidden />
            添加服务器
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      {loading && servers.length === 0 && (
        <div className="flex justify-center py-10"><Spinner size="md" /></div>
      )}
      {!loading && servers.length === 0 && (
        <EmptyState
          icon="i-mdi:server-outline"
          title="暂无 MCP 服务器"
          hint={'点击"添加服务器"或到左侧「MCP 市场」挑选'}
          animate
          className="py-16"
        />
      )}
      {servers.length > 0 && (
        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-2 pr-2">
            {servers.map((server, index) => (
              <div
                key={server.name}
                className="ema-stagger-in"
                style={{ '--stagger-i': index } as CSSProperties}
              >
                <ServerRow
                  server={server}
                  onToggleEnabled={() => void handleToggleEnabled(server)}
                  onRemove={() => setPendingRemove(server.name)}
                  onEdit={() => handleEdit(server)}
                />
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <McpImportDialog open={importOpen} onOpenChange={setImportOpen} />
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
        open={pendingRemove !== null}
        message={pendingRemove ? `确定移除 MCP 服务器 "${pendingRemove}"?` : ''}
        confirmText="移除"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
