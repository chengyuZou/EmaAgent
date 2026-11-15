import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Dialog, DropdownMenu, Spinner, Switch, ToolSpecItem, Tooltip,
} from '@ema-agent/ui';
import { useMcpStore } from '../../stores/mcp.js';
import { mcpApi, type McpServerDetail, type McpServerSummary } from '../../api/mcp.js';
import { showToast } from '../../lib/notifications/toast.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import type { McpConnectionStatus } from '@ema-agent/mcp';

const STATUS_BADGE: Record<McpConnectionStatus, { variant: 'success' | 'warn' | 'danger' | 'neutral'; label: string }> = {
  connected:    { variant: 'success', label: '已连接' },
  connecting:   { variant: 'warn',    label: '连接中' },
  failed:       { variant: 'danger',  label: '连接失败' },
  disconnected: { variant: 'neutral', label: '未连接' },
};

const OAUTH_BADGE: Record<'required' | 'authorizing' | 'authorized', { variant: 'success' | 'warn'; label: string }> = {
  required:    { variant: 'warn',    label: '待授权' },
  authorizing: { variant: 'warn',    label: '授权中' },
  authorized:  { variant: 'success', label: 'OAuth 已授权' },
};

export function toolParamNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema && (schema as { properties?: unknown }).properties;
  return props && typeof props === 'object' ? Object.keys(props as object) : [];
}

export function ServerRow({
  server, onToggleEnabled, onRemove, onEdit,
}: {
  server:           McpServerSummary;
  onToggleEnabled:  () => void;
  onRemove:         () => void;
  onEdit:           () => void;
}): JSX.Element {
  const st = STATUS_BADGE[server.connectionStatus];
  const [expanded, setExpanded]     = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hasOpened, setHasOpened] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  useEffect(() => { if (expanded) setHasOpened(true); }, [expanded]);
  const needsDetail = expanded || detailOpen;
  const actionBusy = connectionBusy || oauthBusy;
  const oauthStatus = resolveVisibleOAuthStatus(server);
  const authorizationUrl = server.oauth?.authorizationUrl;
  const configSignature = JSON.stringify(server.config);

  useEffect(() => {
    if (!needsDetail) return;
    let cancelled = false;
    // 状态刷新重拉详情时保留既有 detail, 避免展开列表短暂清空闪烁.
    setDetail((current) => (current?.name === server.name ? current : null));
    setDetailError(null);
    setDetailLoading(true);
    void mcpApi.get(server.name)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    needsDetail,
    server.name,
    server.connectionStatus,
    server.toolCount,
    server.authType,
    server.oauth?.status,
    server.oauth?.updatedAt,
    configSignature,
  ]);

  async function handleConnect(): Promise<void> {
    if (!server.enabled) {
      showToast('请先启用该服务器', { variant: 'warning' });
      return;
    }
    setConnectionBusy(true);
    try {
      await useMcpStore.getState().connect(server.name);
      showToast(`${server.name} 正在连接`, { variant: 'success' });
    } catch (err) {
      showToast(`连接失败: ${messageOf(err)}`, { variant: 'danger' });
    } finally {
      setConnectionBusy(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    setConnectionBusy(true);
    try {
      await useMcpStore.getState().disconnect(server.name);
    } catch (err) {
      showToast(`断开失败: ${messageOf(err)}`, { variant: 'danger' });
    } finally {
      setConnectionBusy(false);
    }
  }

  async function handleStartOAuth(): Promise<void> {
    setOauthBusy(true);
    try {
      const url = await useMcpStore.getState().startOAuth(server.name);
      if (url) {
        await tauriBridge.openUrl(url);
      } else {
        showToast(`${server.name} 已有有效授权凭据`, { variant: 'success' });
      }
    } catch (err) {
      showToast(`发起授权失败: ${messageOf(err)}`, { variant: 'danger' });
    } finally {
      setOauthBusy(false);
    }
  }

  async function handleCancelOAuth(): Promise<void> {
    setOauthBusy(true);
    try {
      await useMcpStore.getState().cancelOAuth(server.name);
      showToast(`已取消 ${server.name} 的 OAuth 授权`, { variant: 'success' });
    } catch (err) {
      showToast(`取消授权失败: ${messageOf(err)}`, { variant: 'danger' });
    } finally {
      setOauthBusy(false);
    }
  }

  async function handleClearOAuthTokens(): Promise<void> {
    setOauthBusy(true);
    try {
      await useMcpStore.getState().clearOAuthTokens(server.name);
      showToast(`已取消 ${server.name} 的授权并断开连接`, { variant: 'success' });
    } catch (err) {
      showToast(`取消授权失败: ${messageOf(err)}`, { variant: 'danger' });
    } finally {
      setOauthBusy(false);
    }
  }

  async function handleCopyAuthUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      showToast('已复制授权链接', { variant: 'success' });
    } catch (err) {
      showToast(`复制失败: ${messageOf(err)}`, { variant: 'danger' });
    }
  }

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
    server.connectionStatus === 'connected'
      ? {
          kind: 'item' as const,
          label: '断开连接',
          icon: 'i-mdi:lan-disconnect',
          disabled: actionBusy,
          onSelect: () => void handleDisconnect(),
        }
      : {
          kind: 'item' as const,
          label: '连接服务器',
          icon: 'i-mdi:lan-connect',
          disabled: !server.enabled || actionBusy,
          onSelect: () => void handleConnect(),
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
    // 不要在包含交互控件的长卡片上加 active:scale-*, 否则展开几十个工具后按下会整体围绕中心位移导致顶部折叠按钮脱靶.
    <Card variant="elevated" padding="sm" className="ema-card-decorate ema-card-decorate--nodes">
      <div className="group flex flex-col min-w-0">
        <div className="flex items-start justify-between gap-3 min-w-0">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="pt-0.5 shrink-0">
              <Badge variant={st.variant} dot />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{server.name}</span>
                <Badge variant={st.variant}>{st.label}</Badge>
                {oauthStatus && (
                  <Badge variant={OAUTH_BADGE[oauthStatus].variant}>{OAUTH_BADGE[oauthStatus].label}</Badge>
                )}
                {server.toolCount > 0 && (
                  <Tooltip content={expanded ? '收起工具' : '展开查看工具'}>
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="pill"
                      className="h-6 px-2 bg-[var(--ema-surface-2)] hover:bg-[var(--ema-surface-3)]"
                      aria-expanded={expanded}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      <span className="i-mdi:tools text-xs" aria-hidden />
                      {server.toolCount}
                      <span className={`i-mdi:chevron-down text-xs transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
                    </Button>
                  </Tooltip>
                )}
              </div>

              <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5 font-mono break-all">
                {server.config.type === 'stdio'
                  ? `${server.config.command} ${server.config.args?.join(' ') ?? ''}`.trim()
                  : server.config.url}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 pt-0.5 flex-wrap justify-end">
            {oauthStatus === 'required' && (
              <Button
                variant="primary"
                size="sm"
                loading={oauthBusy}
                disabled={actionBusy}
                onClick={() => void handleStartOAuth()}
              >进行授权</Button>
            )}
            {oauthStatus === 'authorizing' && (
              // 取消授权只依赖 oauthBusy, 允许用户在等待浏览器回调或连接重整时随时中止当前授权流程.
              <Button
                variant="secondary"
                size="sm"
                loading={oauthBusy}
                disabled={oauthBusy}
                onClick={() => void handleCancelOAuth()}
              >取消授权</Button>
            )}
            {oauthStatus === 'authorized' && (
              <Button
                variant="ghost"
                size="sm"
                loading={oauthBusy}
                disabled={actionBusy}
                onClick={() => void handleClearOAuthTokens()}
              >取消授权</Button>
            )}
            {server.connectionStatus === 'connected' ? (
              <Button
                variant="ghost"
                size="sm"
                loading={connectionBusy}
                disabled={actionBusy}
                onClick={() => void handleDisconnect()}
              >断开</Button>
            ) : server.connectionStatus === 'connecting' ? (
              <Button variant="secondary" size="sm" loading disabled>连接中</Button>
            ) : (
              <Tooltip content={server.enabled ? '连接服务器' : '请先启用该服务器'}>
                <span className="inline-flex">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={connectionBusy}
                    disabled={!server.enabled || actionBusy}
                    onClick={() => void handleConnect()}
                  >连接</Button>
                </span>
              </Tooltip>
            )}
            <Tooltip content={server.enabled ? '禁用(同时断开连接)' : '启用'}>
              <Switch
                checked={server.enabled}
                label={server.name}
                onCheckedChange={onToggleEnabled}
              />
            </Tooltip>
            <div className="opacity-70 group-hover:opacity-100 transition-opacity duration-150">
              <DropdownMenu
                trigger={
                  <Button variant="ghost" size="sm" className="px-1.5" aria-label="更多操作">
                    <span className="i-mdi:dots-vertical text-base text-[var(--ema-text-tertiary)]" aria-hidden />
                  </Button>
                }
                items={menuItems}
                align="end"
              />
            </div>
          </div>
        </div>

        {server.connectionStatus === 'failed' && (
          <p className="text-xs text-[var(--ema-danger)] mt-2 line-clamp-2 break-words">
            {server.connectionError ?? '连接失败'}
          </p>
        )}

        {oauthStatus === 'authorizing' && (
          <div className="mt-2 flex flex-col gap-1.5 rounded-lg px-2.5 py-2 bg-[var(--ema-surface-1)] border border-[var(--ema-border)] min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-[var(--ema-text-secondary)]">正在等待浏览器完成授权...</span>
              {authorizationUrl && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => void handleCopyAuthUrl(authorizationUrl)}>
                    复制链接
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void tauriBridge.openUrl(authorizationUrl)}>
                    重新打开
                  </Button>
                </div>
              )}
            </div>
            {authorizationUrl && (
              <code
                className="block text-[11px] font-mono text-[var(--ema-text-tertiary)] selectable break-all line-clamp-1"
                title={authorizationUrl}
              >
                {authorizationUrl}
              </code>
            )}
          </div>
        )}

        {/* Inline expanded tool list  -  quick glance at names + params
            展开过的内容常驻 DOM: 收起时 0fr 网格负责裁剪, 动画才能双向跑. */}
        <div
          className="ema-collapsible"
          style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
        >
          <div className="min-w-0">
            {hasOpened && (
              <div className="mt-2 flex flex-col gap-1.5">
                {detailLoading && <Spinner size="sm" />}
                {detailError && <p className="text-xs text-[var(--ema-danger)]">{detailError}</p>}
                {detail?.tools.map((tool: McpServerDetail['tools'][number]) => {
                  const params = toolParamNames(tool.inputSchema);
                  return (
                    <ToolSpecItem
                      key={tool.serverToolName}
                      name={tool.serverToolName}
                      params={params}
                      description={tool.description}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={`${server.name} · 详情`}
        description="连接配置与工具参数 schema"
        widthClass="max-w-2xl"
      >
        <div className="flex flex-col gap-4 max-h-[65vh] overflow-auto">
          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">连接配置</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-words rounded-lg p-2.5
                            bg-[var(--ema-surface-0)] text-[var(--ema-text-secondary)] border border-[var(--ema-border)] selectable">
              {configSummary(detail?.config ?? server.config)}
            </pre>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-1">
              工具 ({detail?.toolCount ?? server.toolCount})
            </p>
            {detailLoading ? (
              <Spinner size="sm" />
            ) : detailError ? (
              <p className="text-xs text-[var(--ema-danger)]">{detailError}</p>
            ) : (detail?.tools.length ?? 0) === 0 ? (
              <p className="text-xs text-[var(--ema-text-tertiary)]">尚未发现工具</p>
            ) : (
              <div className="flex flex-col gap-2">
                {detail?.tools.map((tool: McpServerDetail['tools'][number]) => (
                  <div key={tool.serverToolName} className="rounded-lg p-2.5 bg-[var(--ema-surface-1)] border border-[var(--ema-border)]">
                    <span className="text-xs font-mono font-medium text-[var(--ema-text-primary)]">{tool.serverToolName}</span>
                    {tool.description && (
                      <p className="text-[11px] text-[var(--ema-text-tertiary)] mt-0.5">{tool.description}</p>
                    )}
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words mt-1.5 rounded p-2
                                    bg-[var(--ema-surface-0)] text-[var(--ema-text-tertiary)] border border-[var(--ema-border)] selectable">
                      {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
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

function configSummary(config: McpServerSummary['config']): string {
  if (config.type === 'http') {
    return [
      `transport: Streamable HTTP`,
      `url: ${config.url}`,
      `headers: ${Object.keys(config.headers ?? {}).join(', ') || '无'}`,
      `tool timeout: ${config.toolTimeoutSec ?? 120}s`,
    ].join('\n');
  }
  return [
    'transport: stdio',
    `command: ${config.command}`,
    `args: ${config.args.join(' ')}`,
    `cwd: ${config.cwd ?? '默认'}`,
    `environment: ${Object.keys(config.env ?? {}).join(', ') || '无'}`,
    `passthrough: ${config.envPassthrough?.join(', ') || '无'}`,
    `tool timeout: ${config.toolTimeoutSec ?? 120}s`,
  ].join('\n');
}

function resolveVisibleOAuthStatus(
  server: McpServerSummary,
): 'required' | 'authorizing' | 'authorized' | null {
  if (server.config.type !== 'http') return null;
  if (server.oauth) return server.oauth.status;
  if (
    server.connectionStatus === 'failed'
    && /oauth|401|unauthorized|authorization required/i.test(server.connectionError ?? '')
  ) {
    return 'required';
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
