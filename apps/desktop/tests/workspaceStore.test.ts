// 测试 workspaceStore 的标签唯一性、跨 Dock 移动、关闭折叠、每 Session 隔离与持久化。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const S1 = 'sess_1';
const S2 = 'sess_2';

const STORAGE_KEY = 'ema-workspace-layout-v1';

function createLocalStorageMock(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

vi.stubGlobal('localStorage', createLocalStorageMock());

const { useWorkspaceStore, DEFAULT_RIGHT_WIDTH, DEFAULT_BOTTOM_HEIGHT, isRightFullWidth } = await import('../src/stores/workspaceStore.js');
const { fileTab, agentRunTab } = await import('../src/stores/workspaceTypes.js');

function layoutOf(sessionId: string = S1) {
  return useWorkspaceStore.getState().layouts[sessionId as string];
}

function resetStore(): void {
  localStorage.clear();
  useWorkspaceStore.setState({
    layouts: {},
    rightWidth: DEFAULT_RIGHT_WIDTH,
    bottomHeight: DEFAULT_BOTTOM_HEIGHT,
    fullWidthBySession: {},
  });
}

beforeEach(resetStore);

describe('全宽展开（§3.5）', () => {
  it('标记 + Dock 展开 + 有标签三者同时成立才有效', () => {
    const { openTab, setFullWidth } = useWorkspaceStore.getState();

    setFullWidth(S1, true);
    expect(isRightFullWidth(useWorkspaceStore.getState(), S1)).toBe(false);

    openTab(S1, { id: 'review', kind: 'review' });
    expect(isRightFullWidth(useWorkspaceStore.getState(), S1)).toBe(true);
  });

  it('折叠 Dock 丢弃全宽标记，重新打开回到普通宽度', () => {
    const { openTab, setFullWidth, setDockOpen } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    setFullWidth(S1, true);

    setDockOpen(S1, 'right', false);
    expect(isRightFullWidth(useWorkspaceStore.getState(), S1)).toBe(false);

    setDockOpen(S1, 'right', true);
    expect(isRightFullWidth(useWorkspaceStore.getState(), S1)).toBe(false);
  });

  it('关闭最后标签后全宽派生失效', () => {
    const { openTab, closeTab, setFullWidth } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    setFullWidth(S1, true);

    closeTab(S1, 'review');
    expect(isRightFullWidth(useWorkspaceStore.getState(), S1)).toBe(false);
  });

  it('全宽标记不进持久层', () => {
    const { openTab, setFullWidth } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    setFullWidth(S1, true);

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect('fullWidthBySession' in persisted).toBe(false);
  });
});

describe('openTab 与唯一性', () => {
  it('新标签默认进右侧并激活展开', () => {
    useWorkspaceStore.getState().openTab(S1, { id: 'review', kind: 'review' });

    const layout = layoutOf()!;
    expect(layout.rightTabOrder).toEqual(['review']);
    expect(layout.activeRightTabId).toBe('review');
    expect(layout.rightOpen).toBe(true);
  });

  it('同一资源再次打开不产生第二个实例', () => {
    const { openTab } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    openTab(S1, { id: 'review', kind: 'review' });

    const layout = layoutOf()!;
    expect(layout.rightTabOrder).toEqual(['review']);
    expect(Object.keys(layout.tabsById)).toEqual(['review']);
  });

  it('已存在于右侧时指定 bottom 打开：移动同一实例，源 Dock 空则折叠', () => {
    const { openTab } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    openTab(S1, { id: 'files', kind: 'files' });
    openTab(S1, { id: 'review', kind: 'review' }, { dock: 'bottom' });

    const layout = layoutOf()!;
    expect(layout.rightTabOrder).toEqual(['files']);
    expect(layout.bottomTabOrder).toEqual(['review']);
    expect(layout.activeBottomTabId).toBe('review');
    expect(layout.bottomOpen).toBe(true);
    // 右侧仍有 files，不折叠。
    expect(layout.rightOpen).toBe(true);
  });

  it('不指定 dock 时已在底部就只激活不移动', () => {
    const { openTab } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' }, { dock: 'bottom' });
    openTab(S1, { id: 'review', kind: 'review' });

    const layout = layoutOf()!;
    expect(layout.bottomTabOrder).toEqual(['review']);
    expect(layout.rightTabOrder).toEqual([]);
    expect(layout.activeBottomTabId).toBe('review');
  });
});

describe('closeTab 与自动折叠', () => {
  it('关闭激活项时同位置邻居接管激活', () => {
    const { openTab, closeTab } = useWorkspaceStore.getState();
    openTab(S1, agentRunTab('run-a'));
    openTab(S1, agentRunTab('run-b'));
    openTab(S1, agentRunTab('run-c'));
    useWorkspaceStore.getState().activateTab(S1, 'agentRun:run-b');

    closeTab(S1, 'agentRun:run-b');

    const layout = layoutOf()!;
    expect(layout.rightTabOrder).toEqual(['agentRun:run-a', 'agentRun:run-c']);
    expect(layout.activeRightTabId).toBe('agentRun:run-c');
  });

  it('关闭最后标签时 Dock 自动折叠；显式关闭的标签不进持久层', () => {
    const { openTab, closeTab } = useWorkspaceStore.getState();
    openTab(S1, { id: 'sources', kind: 'sources' });
    closeTab(S1, 'sources');

    const layout = layoutOf()!;
    expect(layout.rightOpen).toBe(false);
    expect(layout.rightTabOrder).toEqual([]);
    expect(layout.tabsById).toEqual({});

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      layouts: Record<string, { rightTabOrder: string[] }>;
    };
    expect(persisted.layouts[S1 as string]!.rightTabOrder).toEqual([]);
  });

  it('关闭不存在的标签是 no-op', () => {
    useWorkspaceStore.getState().openTab(S1, { id: 'review', kind: 'review' });
    useWorkspaceStore.getState().closeTab(S1, 'agentRun:ghost');

    expect(layoutOf()!.rightTabOrder).toEqual(['review']);
  });
});

describe('Dock 折叠与恢复', () => {
  it('折叠保留标签，重新打开原样恢复', () => {
    const { openTab, setDockOpen } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    openTab(S1, { id: 'files', kind: 'files' });

    setDockOpen(S1, 'right', false);
    expect(layoutOf()!.rightOpen).toBe(false);
    expect(layoutOf()!.rightTabOrder).toEqual(['review', 'files']);

    setDockOpen(S1, 'right', true);
    expect(layoutOf()!.rightOpen).toBe(true);
    expect(layoutOf()!.activeRightTabId).toBe('files');
  });
});

describe('每 Session 隔离', () => {
  it('两个 Session 的标签与折叠互不影响', () => {
    const { openTab } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' });
    openTab(S2, { id: 'files', kind: 'files' }, { dock: 'bottom' });

    expect(layoutOf(S1)!.rightTabOrder).toEqual(['review']);
    expect(layoutOf(S1)!.bottomTabOrder).toEqual([]);
    expect(layoutOf(S2)!.bottomTabOrder).toEqual(['files']);
    expect(layoutOf(S2)!.rightTabOrder).toEqual([]);
  });
});

describe('全局尺寸偏好', () => {
  it('宽度高度钳制最小值', () => {
    useWorkspaceStore.getState().setRightWidth(100);
    useWorkspaceStore.getState().setBottomHeight(50);
    expect(useWorkspaceStore.getState().rightWidth).toBe(240);
    expect(useWorkspaceStore.getState().bottomHeight).toBe(160);

    useWorkspaceStore.getState().setRightWidth(480);
    expect(useWorkspaceStore.getState().rightWidth).toBe(480);
  });
});

describe('资源键归一', () => {
  it('同一 Windows 路径的不同写法归为一个文件标签', () => {
    const { openTab } = useWorkspaceStore.getState();
    openTab(S1, fileTab('d:\\Github\\EmaAgent\\src\\a.ts'));
    openTab(S1, fileTab('D:/Github/EmaAgent/src//a.ts'));

    const layout = layoutOf()!;
    expect(Object.keys(layout.tabsById)).toEqual(['file:D:/Github/EmaAgent/src/a.ts']);
  });
});

describe('持久化恢复', () => {
  async function reloadStore() {
    vi.resetModules();
    return import('../src/stores/workspaceStore.js');
  }

  it('布局与全局尺寸从 localStorage 恢复', async () => {
    const { openTab, setRightWidth } = useWorkspaceStore.getState();
    openTab(S1, { id: 'review', kind: 'review' }, { dock: 'bottom' });
    setRightWidth(400);

    const reloaded = await reloadStore();
    const layout = reloaded.useWorkspaceStore.getState().layouts[S1 as string]!;
    expect(layout.bottomTabOrder).toEqual(['review']);
    expect(layout.bottomOpen).toBe(true);
    expect(reloaded.useWorkspaceStore.getState().rightWidth).toBe(400);
  });

  it('损坏 JSON 按默认布局启动', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    const reloaded = await reloadStore();
    expect(reloaded.useWorkspaceStore.getState().layouts).toEqual({});
  });

  it('失效的激活项与空 Dock 的 open 标记在恢复时被纠正', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      layouts: {
        [S1 as string]: {
          tabsById: { review: { id: 'review', kind: 'review' } },
          rightTabOrder: ['review'],
          bottomTabOrder: [],
          activeRightTabId: 'agentRun:ghost',
          activeBottomTabId: 'files',
          rightOpen: true,
          bottomOpen: true,
        },
      },
      rightWidth: 320,
      bottomHeight: 240,
    }));

    const reloaded = await reloadStore();
    const layout = reloaded.useWorkspaceStore.getState().layouts[S1 as string]!;
    expect(layout.activeRightTabId).toBeUndefined();
    expect(layout.activeBottomTabId).toBeUndefined();
    expect(layout.rightOpen).toBe(true);
    // bottom 没有任何标签，open 标记不可信，纠正为折叠。
    expect(layout.bottomOpen).toBe(false);
  });
});
