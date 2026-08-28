import { useState } from 'react';
import {
  Badge, Button, Card, Dialog, DropdownMenu, Switch, ToolSpecItem, Tooltip,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import type { McpServerItem } from '../../api/mcp.js';
import { showToast } from '../../lib/toast.js';
import type { McpConnectionStatus } from '@ema-agent/mcp';

const STATUS_BADGE: Record<McpConnectionStatus, { variant: 'success' | 'warn' | 'danger' | 'neutral'; label: string }> = {
  connected:    { variant: 'success', label: '已连接' },
  connecting:   { variant: 'warn',    label: '连接中' },
  failed:       { variant: 'danger',  label: '连接失败' },
  disconnected: { variant: 'neutral', label: '未连接' },
};

export function toolParamNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema && (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? Object.keys(props as object) : [];
}

export function ServerRow({
  server, onToggleEnabled, onRemove, onEdit,
}: {
  server:           McpServerItem;
  onToggleEnabled:  () => void;
  onRemove:         () => void;
  onEdit:           () => void;
}): JSX.Element {
  const st = STATUS_BADGE[server.connection.status as McpConnectionStatus] ?? STATUS_BADGE.disconnected;
  const tools = server.connection.tools;
  const toolCount = tools.length;
  const [expanded, setExpanded]     = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const menuItems = [
    {
      kind: 'item' as const,
      label: '编辑 / 鉴权',
      icon: 'i-mdi:pencil-outline',
      onSelect: onEdit,
    },
    {
      kind: 'item' as const,
      label: '详情 / 参数',
      icon: 'i-mdi:information-outline',
      onSelect: () => setDetailOpen(true),
    },
    { kind: 'separator' as const },
    server.connection.status === 'connected'
      ? {
          kind: 'item' as const,
          label: '断开连接',
          icon: 'i-mdi:lan-disconnect',
          onSelect: () => void useMcpStore.getState().disconnect(server.name)
            .catch((err: Error) => showToast(`断开失败: ${err.message}`, { variant: 'danger' })),
        }
      : {
          kind: 'item' as const,
          label: '重新连接',
          icon: 'i-mdi:lan-connect',
          onSelect: () => void useMcpStore.getState().connect(server.name)
            .then(() => showToast(`${server.name} 已连接`, { variant: 'success' }))
            .catch((err: Error) => showToast(`连接失败: ${err.message}`, { variant: 'danger' })),
        },
    { kind: 'separator' as const },
    {
      kind: 'item' as const,
      label: '移除服务器',
      icon: 'i-mdi:delete-outline',
      danger: true,
      onSelect: onRemove,
    },
  ];

  return (
    <Card variant="elevated" padding="sm" className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--circuit">
      <div className="group flex items-start gap-3">
        {/* Status dot */}
        <div className="pt-0.5 shrink-0">
          <Badge variant={st.variant} dot />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{server.name}</span>
            <Badge variant={st.variant}>{st.label}</Badge>
            {toolCount > 0 && (
              <button
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs
                           bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)]
                           hover:bg-[var(--ema-surface-3)] transition-colors"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? '收起工具' : '展开查看工具'}
              >
                <span className="i-mdi:tools text-xs" aria-hidden />
                {toolCount}
                <span className={`i-mdi:chevron-down text-xs transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
              </button>
            )}
          </div>

          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5 font-mono">
            {server.config.type === 'stdio'
              ? `${server.config.command} ${server.config.args?.join(' ') ?? ''}`.trim()
              : (server.config as { url: string }).url}
          </p>

          {server.connection.status === 'failed' && (
            <p className="text-xs text-[var(--ema-danger)] mt-1 line-clamp-1">
              连接错误
            </p>
          )}

          {/* Inline expanded tool list — quick glance at names + params */}
          {expanded && toolCount > 0 && (
            <div className="mt-2 flex flex-col gap-1.5 ema-slide-up">
              {tools.map((t: McpServerItem['connection']['tools'][number]) => {
                const params = toolParamNames(t.inputSchema);
                return (
                  <ToolSpecItem key={t.serverToolName} name={t.serverToolName} params={params} description={t.description} />
                );
              })}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <Tooltip content={server.enabled ? '禁用(下次启动不自动连接)' : '启用'}>
            <Switch
              checked={server.enabled}
              label={server.name}
              onCheckedChange={onToggleEnabled}
            />
          </Tooltip>
          {/* DropdownMenu hover 显隐(抄 session 列表 opacity-0 group-hover:opacity-100) */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            <DropdownMenu
              trigger={
                <Button variant="ghost" size="sm" className="px-1.5">
                  <span className="i-mdi:dots-vertical text-base text-[var(--ema-text-tertiary)]" aria-hidden />
                </Button>
              }
              items={menuItems}
              align="end"
            />
          </div>
        </div>
      </div>

      {/* Detail dialog — full config + every tool's parameter schema */}
      <Dialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={`${server.name} · 详情`}
        description="连接配置与工具参数 schema"
        widthClass="max-w-2xl"
      >
        <div className="flex flex-col gap-4 max-h-[65vh] overflow-auto">
          {/* Config */}
          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">连接配置</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-lg p-2.5
                            bg-[var(--ema-surface-0)] text-[var(--ema-text-secondary)] border border-[var(--ema-border)] selectable">
              {JSON.stringify(server.config, null, 2)}
            </pre>
          </div>

          {/* Tools */}
          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">
              工具 ({toolCount})
            </p>
            {toolCount === 0 ? (
              <p className="text-xs text-[var(--ema-text-tertiary)]">未连接或无工具（连接后才能读取）</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tools.map((t: McpServerItem['connection']['tools'][number]) => (
                  <div key={t.serverToolName} className="rounded-lg p-2.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
                    <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{t.serverToolName}</span>
                    {t.description && (
                      <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5">{t.description}</p>
                    )}
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words mt-1.5 rounded p-2
                                    bg-[var(--ema-surface-0)] text-[var(--ema-text-tertiary)] border border-[var(--ema-border)] selectable">
                      {JSON.stringify(t.inputSchema ?? {}, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </Card>
  );
}