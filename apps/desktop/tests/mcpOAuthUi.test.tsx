// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { ServerRow } from '../src/settings/mcp/McpServerRow.js';
import { McpServerFormDialog } from '../src/settings/mcp/McpServerDialogs.js';
import { handleMcpSystemEvent, useMcpStore } from '../src/stores/mcp.js';
import type { McpServerDetail, McpServerSummary } from '../src/api/mcp.js';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  startOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  clearOAuthTokens: vi.fn(),
  probe: vi.fn(),
  toast: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('../src/api/mcp.js', () => ({
  mcpApi: {
    list: api.list,
    get: api.get,
    create: api.create,
    update: api.update,
    connect: api.connect,
    disconnect: api.disconnect,
    startOAuth: api.startOAuth,
    cancelOAuth: api.cancelOAuth,
    clearOAuthTokens: api.clearOAuthTokens,
    probe: api.probe,
  },
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));
vi.mock('../src/lib/tauri/tauriBridge.js', () => ({
  tauriBridge: { openUrl: api.openUrl },
}));

function makeHttpServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: 'srv-notion',
    name: 'notion',
    provenance: { sourceKind: 'manual' },
    config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    enabled: true,
    authType: 'oauth',
    connectionStatus: 'disconnected',
    toolCount: 0,
    oauth: { status: 'required', expiresAtMs: null, updatedAt: 0 },
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useMcpStore.setState(useMcpStore.getInitialState(), true);
  api.list.mockResolvedValue({ items: [] });
  api.get.mockResolvedValue({ ...makeHttpServer(), tools: [] });
  api.create.mockResolvedValue({ id: 'srv-created' });
  api.update.mockResolvedValue({ ok: true });
  api.connect.mockResolvedValue({ ok: true });
  api.disconnect.mockResolvedValue({ ok: true });
  api.startOAuth.mockResolvedValue({ authorizationUrl: 'https://mcp.notion.com/authorize?state=abc' });
  api.cancelOAuth.mockResolvedValue({ ok: true });
  api.clearOAuthTokens.mockResolvedValue({ ok: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.clearAllMocks();
});

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((btn) => btn.textContent?.trim() === text);
}

describe('MCP OAuth store events & desktop UI', () => {
  it('handleMcpSystemEvent 收到 mcp_oauth_changed 时刷新已加载的服务器列表', async () => {
    const server = makeHttpServer();
    useMcpStore.setState({ servers: [server] });
    api.list.mockResolvedValueOnce({
      items: [makeHttpServer({ oauth: { status: 'authorized', expiresAtMs: null, updatedAt: 200 } })],
    });

    handleMcpSystemEvent({ type: 'mcp_oauth_changed' });

    await vi.waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(useMcpStore.getState().servers[0]?.oauth?.status).toBe('authorized');
    });
  });

  it('ServerRow 禁用时不许连接, OAuth 三态控件可见并可交互, 刷新详情不闪烁', async () => {
    const noop = () => undefined;
    const renderRow = async (server: McpServerSummary) => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ServerRow server={server} onToggleEnabled={noop} onRemove={noop} onEdit={noop} />
          </TooltipProvider>,
        );
      });
    };

    // 1. 禁用 + required: 连接按钮禁用, 进行授权按钮直接位于连接按钮前面
    await renderRow(makeHttpServer({ enabled: false }));
    const connectBtnDisabled = buttonByText(host, '连接')!;
    expect(connectBtnDisabled.disabled).toBe(true);
    const goAuthBtn = buttonByText(host, '进行授权')!;
    expect(goAuthBtn).toBeDefined();
    expect(goAuthBtn.compareDocumentPosition(connectBtnDisabled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      goAuthBtn.click();
    });
    expect(api.startOAuth).toHaveBeenCalledWith('notion');
    expect(api.openUrl).toHaveBeenCalledWith('https://mcp.notion.com/authorize?state=abc');

    // 2. authorizing: 头部显示取消授权(位于连接前), 下方提供复制链接与重新打开
    await renderRow(makeHttpServer({
      oauth: {
        status: 'authorizing',
        authorizationUrl: 'https://mcp.notion.com/authorize?state=xyz',
        expiresAtMs: null,
        updatedAt: 100,
      },
    }));
    expect(host.textContent).toContain('https://mcp.notion.com/authorize?state=xyz');
    const reopenBtn = buttonByText(host, '重新打开')!;
    const cancelBtn = buttonByText(host, '取消授权')!;
    const connectBtnDuringAuth = buttonByText(host, '连接')!;
    expect(cancelBtn.compareDocumentPosition(connectBtnDuringAuth) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(buttonByText(host, '复制链接')).toBeDefined();
    await act(async () => {
      reopenBtn.click();
    });
    expect(api.openUrl).toHaveBeenLastCalledWith('https://mcp.notion.com/authorize?state=xyz');
    await act(async () => {
      cancelBtn.click();
    });
    expect(api.cancelOAuth).toHaveBeenCalledWith('notion');

    // 3. authorized + toolCount > 0: 取消授权位于连接前且无独立已授权横幅, 展开工具后刷新不闪烁
    const cachedTool: McpServerDetail['tools'][number] = {
      serverToolName: 'search',
      qualifiedName: 'mcp__notion__search',
      originalServerName: 'notion',
      description: 'Search pages',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      reportedDestructive: false,
    };
    api.get.mockResolvedValueOnce({
      ...makeHttpServer({
        toolCount: 1,
        oauth: { status: 'authorized', expiresAtMs: Date.now() + 60_000, updatedAt: 200 },
      }),
      tools: [cachedTool],
    });
    await renderRow(makeHttpServer({
      toolCount: 1,
      oauth: { status: 'authorized', expiresAtMs: Date.now() + 60_000, updatedAt: 200 },
    }));

    expect(host.textContent).not.toContain('OAuth 已授权，凭据已保存');
    expect(host.firstElementChild?.className ?? '').not.toContain('active:scale-');
    const revokeBtn = buttonByText(host, '取消授权')!;
    expect(revokeBtn).toBeDefined();
    const connectBtnWhenAuthed = buttonByText(host, '连接')!;
    expect(revokeBtn.compareDocumentPosition(connectBtnWhenAuthed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const expandBtn = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === '1')!;
    expect(expandBtn.type).toBe('button');
    expect(expandBtn.className).toContain('rounded-pill');
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      expandBtn.click();
    });
    expect(expandBtn.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => {
      expect(host.textContent).toContain('search');
    });

    // 第二次拉取详情挂起期间, 已展示的工具名必须保留在 DOM 中
    let resolveSecondDetail!: (value: McpServerDetail) => void;
    api.get.mockImplementationOnce(() => new Promise<McpServerDetail>((resolve) => {
      resolveSecondDetail = resolve;
    }));
    await renderRow(makeHttpServer({
      toolCount: 1,
      connectionStatus: 'connected',
      oauth: { status: 'authorized', expiresAtMs: Date.now() + 60_000, updatedAt: 200 },
    }));
    expect(host.textContent).toContain('search');
    await act(async () => {
      resolveSecondDetail({
        ...makeHttpServer({
          toolCount: 1,
          connectionStatus: 'connected',
          oauth: { status: 'authorized', expiresAtMs: Date.now() + 60_000, updatedAt: 200 },
        }),
        tools: [cachedTool],
      });
    });
    await act(async () => {
      revokeBtn.click();
    });
    expect(api.clearOAuthTokens).toHaveBeenCalledWith('notion');

    // 4. authType=none 但 401 失败的 HTTP 服务器仍显示进行授权入口
    await renderRow(makeHttpServer({
      authType: 'none',
      oauth: undefined,
      connectionStatus: 'failed',
      connectionError: 'OAuth authorization required',
    }));
    expect(buttonByText(host, '进行授权')).toBeDefined();
    expect(host.textContent).toContain('OAuth authorization required');
  });

  it('McpServerFormDialog 只保留「保存」按钮, 新建 HTTP OAuth 不自动连接或发起授权', async () => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <McpServerFormDialog key="new" open editing={null} onOpenChange={() => undefined} />
        </TooltipProvider>,
      );
    });

    expect(buttonByText(document.body, '保存')).toBeDefined();
    expect(buttonByText(document.body, '测试连接')).toBeDefined();
    expect(buttonByText(document.body, '保存并去授权')).toBeUndefined();
    expect(buttonByText(document.body, '添加')).toBeUndefined();

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const nameInput = document.body.querySelector<HTMLInputElement>('input[placeholder="my-server"]')!;
    await act(async () => {
      setInputValue(nameInput, 'invalid name!');
    });
    expect(document.body.textContent).toContain('只能包含字母, 数字, 连字符 (-) 和下划线 (_)');

    await act(async () => {
      setInputValue(nameInput, 'local-tools');
    });
    const cmdInput = document.body.querySelector<HTMLInputElement>('input[placeholder="uvx / npx / /path/to/binary"]')!;
    await act(async () => {
      setInputValue(cmdInput, 'npx');
    });
    const createSaveBtn = buttonByText(document.body, '保存')!;
    expect(createSaveBtn.disabled).toBe(false);
    await act(async () => {
      createSaveBtn.click();
    });
    expect(api.create).toHaveBeenCalledWith({
      name: 'local-tools',
      config: { type: 'stdio', command: 'npx', args: [] },
      authType: 'none',
    });

    const editForm = makeHttpServer({
      name: 'notion-docs',
      config: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer static' } },
      authType: 'oauth',
    });
    await act(async () => {
      root.render(
        <TooltipProvider>
          <McpServerFormDialog key="edit-notion" open editing={editForm} onOpenChange={() => undefined} />
        </TooltipProvider>,
      );
    });

    expect(document.body.textContent).toContain('OAuth 模式下如同时保留静态 Authorization 请求头');
    expect(buttonByText(document.body, '测试连接')).toBeUndefined();
    const saveBtn = buttonByText(document.body, '保存')!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });

    expect(api.update).toHaveBeenCalledWith(
      'notion-docs',
      {
        config: {
          type: 'http',
          url: 'https://mcp.notion.com/mcp',
          headers: { Authorization: 'Bearer static' },
        },
        provenance: { sourceKind: 'manual' },
        authType: 'oauth',
      },
    );
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.startOAuth).not.toHaveBeenCalled();
  });
});
