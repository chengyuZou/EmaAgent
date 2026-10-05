// @vitest-environment jsdom
// 连续消息窗口按真实 MessageId 合并、分页和切换; 布局由浏览器夹具验证.
import {
  act,
  createElement,
  useRef,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import type { SubagentMessage } from '@ema-agent/agent';
import { SubagentMessages } from '../src/chat/sidePanel/tabs/subagents/subagentMessages.js';
import { SubagentPanel } from '../src/chat/sidePanel/tabs/subagents/SubagentPanel.js';
import { useSubagentStore } from '../src/stores/subagent.js';
import { useSessionPanelStore } from '../src/stores/sessionPanel.js';

const api = vi.hoisted(() => ({
  listMessages: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../src/api/subagents.js', () => ({
  subagentsApi: api,
}));
vi.mock(
  '../src/stores/theme.js',
  () => ({
    useThemeStore: (select: (state: {
      readingFont: string;
      codeFont: string
    }) => unknown) => (
      select({
        readingFont: '',
        codeFont: ''
      })
    ),
  })
);

vi.mock(
  '@ema-agent/ui',
  () => ({
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children: ReactNode;
      onClick(): void;
      disabled?: boolean;
    }) => createElement(
      'button',
      {
        onClick,
        disabled
      },
      children
    ),
    IconButton: ({
      label,
      onClick,
    }: {
      label: string;
      onClick(): void;
    }) => createElement(
      'button',
      {
        'aria-label': label,
        onClick,
      },
      label
    ),
    Spinner: () => null,
  })
);

vi.mock(
  '../src/chat/messages/UIMessage.js',
  () => ({
    UIMessage: ({ message }: { message: SubagentMessage }) => (
      createElement(
        'p',
        {},
        String(message.blocks)
      )
    ),
    toolResultsForMessages: () => new Map(),
  })
);

interface VirtualOptions {
  count: number;
  getItemKey(index: number): string;
  getScrollElement(): HTMLDivElement | null;
}

vi.mock(
  '@tanstack/react-virtual',
  () => ({
    useVirtualizer: (options: VirtualOptions) => {
      const current = useRef(options);
      current.current = options;
      const instance = useRef({
        elementsCache: new Map(),
        measurementsCache: [],
        measure: () => { },
        measureElement: () => { },
        getTotalSize: () => current.current.count * 100,
        getVirtualItems: () => Array.from(
          {
            length: current.current.count
          },
          (_, index) => ({
            index,
            key: current.current.getItemKey(index),
            start: index * 100,
          }),
        ),
        getVirtualItemForOffset: () => undefined,
        scrollToOffset: (offset: number) => {
          const scroller = current.current.getScrollElement();
          if (scroller) scroller.scrollTop = offset;
        },
        scrollToEnd: () => {
          const scroller = current.current.getScrollElement();
          if (scroller) {
            scroller.scrollTop = 1_000;
          }
        },
        isAtEnd: () => true,
        getDistanceFromEnd: () => 0,
      });
      return instance.current;
    },
  })
);

Object.assign(
  globalThis,
  {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe(): void { }
      disconnect(): void { }
    },
  }
);

let root: Root;
let host: HTMLDivElement;

function message(
  index: number,
  runId: string | null = 'run',
  subagentId = 'child',
): SubagentMessage {
  return {
    id: 'm-' + index,
    subagentId,
    runId,
    role: 'user',
    kind: 'normal',
    blocks: '消息 ' + index,
    createdAt: index,
    summarizedThroughMessageId: null,
  };
}

function page(items: SubagentMessage[], older = false) {
  return {
    items,
    olderCursor: older
      ? {
        id: items[0]!.id,
        createdAt: items[0]!.createdAt,
      }
      : null,
    newerCursor: null,
  };
}

async function render(subagentId = 'child'): Promise<void> {
  await act(async () => {
    root.render(createElement(
      SubagentMessages,
      {
        subagentId,
        sessionId: 'session',
      }
    ));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSubagentStore.setState({
    subagents: new Map(),
    runsById: new Map(),
    toolReferences: new Map(),
    streamingMessages: new Map(),
    progressById: new Map(),
    openMessageIds: new Set(),
    toolProgress: new Map(),
  });
  useSessionPanelStore.setState({
    layouts: {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe(
  '子代理连续消息窗口',
  () => {
    it(
      '从详情返回列表后, 点击同一个子代理工具入口仍然打开详情',
      async () => {
        const identity = {
          id: 'child',
          sessionId: 'session',
          title: '测试子代理',
          description: '同一身份重复打开',
          status: 'completed',
          createdAt: 1,
          updatedAt: 1,
        };
        api.list.mockResolvedValue({
          items: [identity],
          nextCursor: null,
        });
        api.get.mockResolvedValue(identity);
        api.listMessages.mockResolvedValue(page([message(1)]));

        function ConnectedPanel() {
          const tab = useSessionPanelStore(state => (
            state.layouts.session?.tabsById.subagents
          ));
          return createElement(
            SubagentPanel,
            {
              sessionId: 'session',
              initialDetailId: tab?.kind === 'subagents' ? tab.subagentId : undefined,
            }
          );
        }

        useSessionPanelStore.getState().openTab(
          'session',
          {
            id: 'subagents',
            kind: 'subagents',
            subagentId: 'child',
          }
        );
        await act(async () => root.render(createElement(ConnectedPanel)));
        expect(host.querySelector('[aria-label="返回子代理列表"]')).not.toBeNull();

        await act(async () => {
          host.querySelector<HTMLButtonElement>('[aria-label="返回子代理列表"]')!.click();
        });
        expect(host.querySelector('[aria-label="返回子代理列表"]')).toBeNull();
        expect(host.textContent).toContain('测试子代理');

        await act(async () => {
          useSessionPanelStore.getState().openTab(
            'session',
            {
              id: 'subagents',
              kind: 'subagents',
              subagentId: 'child',
            }
          );
        });
        expect(host.querySelector('[aria-label="返回子代理列表"]')).not.toBeNull();
        expect(api.get).toHaveBeenCalledTimes(2);
        expect(api.listMessages).toHaveBeenCalledTimes(2);
      }
    );

    it(
      '补早页时保留 fork 与不同 Run, 相同 ID 只保留一条',
      async () => {
        api.listMessages
          .mockResolvedValueOnce(page([message(3, 'first'), message(4, 'second')], true))
          .mockResolvedValueOnce(page([message(1, null), message(2, 'first'), message(3, 'first')]));
        await render();
        expect(host.querySelectorAll('[data-message-id]')).toHaveLength(2);

        const older = [...host.querySelectorAll('button')]
          .find(button => button.textContent === '更早消息')!;
        await act(async () => older.click());

        expect(host.querySelectorAll('[data-message-id]')).toHaveLength(4);
        expect([...host.querySelectorAll('[data-message-id]')].map(row => row.textContent))
          .toEqual(['消息 1', '消息 2', '消息 3', '消息 4']);
      }
    );

    it(
      '已有身份暂无消息时正常显示空状态, 真实消息到达直接合并',
      async () => {
        api.listMessages.mockResolvedValueOnce(page([]));
        await render();
        expect(host.textContent).toContain('暂无可显示的消息');

        await act(async () => {
          useSubagentStore.getState().receiveEvent(
            'session',
            {
              type: 'message_updated',
              subagentId: 'child',
              runId: 'run',
              message: message(1),
              streaming: false,
            }
          );
        });

        expect(api.listMessages).toHaveBeenCalledTimes(1);
        expect(host.textContent).toContain('消息 1');
        expect(host.textContent).not.toContain('暂无可显示的消息');
      }
    );

    it(
      '切换子代理取消旧请求, 迟到结果不覆盖新窗口',
      async () => {
        let oldSignal!: AbortSignal;
        let release!: (value: ReturnType<typeof page>) => void;
        api.listMessages
          .mockImplementationOnce((
            _id: string,
            _cursor: unknown,
            _direction: string,
            signal: AbortSignal,
          ) => {
            oldSignal = signal;
            return new Promise(resolve => {
              release = resolve;
            });
          })
          .mockResolvedValueOnce(page([message(
            2,
            'new',
            'other'
          )]));

        await render('child');
        await render('other');
        expect(oldSignal.aborted).toBe(true);
        await act(async () => release(page([message(1, 'old')])));

        expect(host.textContent).toContain('消息 2');
        expect(host.textContent).not.toContain('消息 1');
      }
    );

    it(
      '真正的请求失败显示可重试状态, 成功后清掉错误',
      async () => {
        api.listMessages
          .mockRejectedValueOnce(new Error('连接中断'))
          .mockResolvedValueOnce(page([message(1)]));
        await render();
        expect(host.textContent).toContain('读取子代理消息失败: 连接中断');

        const retry = [...host.querySelectorAll('button')]
          .find(button => button.textContent === '重试')!;
        await act(async () => retry.click());

        expect(api.listMessages).toHaveBeenCalledTimes(2);
        expect(host.textContent).toContain('消息 1');
        expect(host.textContent).not.toContain('连接中断');
      }
    );
  }
);
