// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { SkillMarketPage } from '../src/settings/skills/SkillMarketPage.js';
import { useSkillStore } from '../src/stores/skill.js';
import { dispatchSystemEvent } from '../src/lib/events/systemEventDispatcher.js';
import type {
  skillsApi,
  SkillMarketInstallBody,
  SkillMarketItem,
  SkillMarketList,
} from '../src/api/skills.js';

const api = vi.hoisted(() => ({
  market: vi.fn(),
  detail: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  list: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/api/skills.js', () => ({
  skillsApi: {
    marketList: api.market,
    marketDetail: api.detail,
    marketInstall: api.install,
    marketUninstall: api.uninstall,
    list: api.list,
  },
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));

const entries: SkillMarketItem[] = ['a', 'b'].map(slug => ({
  id: `clawhub:${slug}`,
  source: 'clawhub',
  slug,
  name: `Fixture ${slug}`,
  summary: 'Local test fixture',
  tags: [],
  downloads: 0,
  installState: 'installable',
}));

type InstallResult = Awaited<ReturnType<typeof skillsApi.marketInstall>>;

let host: HTMLDivElement;
let root: Root;
let installed: Set<string>;
let pending: Map<string, { finish(): void; fail(): void }>;

function marketItems(): SkillMarketItem[] {
  return entries.map(entry => ({
    ...entry,
    installState: installed.has(entry.id) ? 'installed' : 'installable',
  }));
}

async function render(visible: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <TooltipProvider>
        {visible ? <SkillMarketPage /> : <div>Other settings page</div>}
      </TooltipProvider>,
    );
  });
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === label || element.getAttribute('aria-label') === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function card(index = 0): HTMLElement {
  const result = [...host.querySelectorAll<HTMLElement>('.ema-card-decorate')]
    .find(element => element.textContent?.includes(entries[index]!.name));
  if (!result) throw new Error(`Missing skill card: ${index}`);
  return result;
}

async function install(index = 0): Promise<void> {
  await act(async () => button(card(index), '安装').click());
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => button(dialog, '安装').click());
}

function expectInstalling(index: number): void {
  const installButton = button(card(index), '安装');
  expect.soft(installButton.getAttribute('aria-busy')).toBe('true');
  expect.soft(installButton.disabled).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  installed = new Set();
  pending = new Map();
  useSkillStore.setState(useSkillStore.getInitialState(), true);
  api.list.mockResolvedValue({ items: [] });
  api.market.mockImplementation(async (): Promise<SkillMarketList> => ({
    items: marketItems(),
    nextCursor: null,
    sources: { clawhub: { status: 'ok' }, skillhub: { status: 'ok' } },
  }));
  api.detail.mockImplementation(async (_source, slug) => ({
    skill: {
      ...marketItems().find(entry => entry.slug === slug)!,
      description: 'Fixture documentation',
      files: [],
      totalSize: 0,
    },
    sourceStatus: { status: 'ok' },
  }));
  api.uninstall.mockImplementation(async (input: SkillMarketInstallBody) => {
    installed.delete(`${input.source}:${input.slug}`);
    dispatchSystemEvent({ type: 'skills_changed' });
    return { ok: true };
  });
  api.install.mockImplementation((input: SkillMarketInstallBody) => {
    const id = `${input.source}:${input.slug}`;
    return new Promise<InstallResult>((resolve, reject) => {
      pending.set(id, {
        finish() {
          installed.add(id);
          pending.delete(id);
          dispatchSystemEvent({ type: 'skills_changed' });
          resolve({
            name: `Fixture ${input.slug}`,
            path: `C:/fixture/${input.slug}/SKILL.md`,
            dirName: input.slug,
          });
        },
        fail() {
          pending.delete(id);
          reject(new Error('fixture installation failed'));
        },
      });
    });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    for (const operation of pending.values()) operation.fail();
  });
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each(['stay', 'remount'] as const)('keeps an installation and its completion visible with %s', async action => {
  await render(true);
  await install();
  expectInstalling(0);
  if (action === 'remount') await render(false);
  await render(true);
  expectInstalling(0);
  await act(async () => pending.get(entries[0]!.id)!.finish());
  expect(card().textContent).toContain('已安装');
  expect(api.install).toHaveBeenCalledOnce();
  expect(api.toast).toHaveBeenCalledOnce();
});

it.each(['stay', 'remount'] as const)('keeps concurrent installations independent with %s', async action => {
  await render(true);
  await install(0);
  await install(1);
  if (action === 'remount') await render(false);
  await render(true);
  expectInstalling(0);
  expectInstalling(1);
  await act(async () => pending.get(entries[0]!.id)!.finish());
  expect.soft(card(0).textContent).toContain('已安装');
  expectInstalling(1);
  await act(async () => pending.get(entries[1]!.id)!.fail());
  expect(button(card(1), '安装').disabled).toBe(false);
  expect(api.toast).toHaveBeenCalledWith('安装失败: fixture installation failed', { variant: 'danger' });
  await install(1);
  await act(async () => pending.get(entries[1]!.id)!.finish());
  expect(card(1).textContent).toContain('已安装');
});

it('refreshes the current detail after returning during installation', async () => {
  await render(true);
  await install();
  await render(false);
  await render(true);
  await act(async () => card().querySelector<HTMLButtonElement>('button')!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Fixture a');
  await act(async () => pending.get(entries[0]!.id)!.finish());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('卸载');
});

it('reads completion when installation finishes while the page is absent', async () => {
  await render(true);
  await install();
  await render(false);
  await act(async () => pending.get(entries[0]!.id)!.finish());
  await render(true);
  expect(card().textContent).toContain('已安装');
});

it('reports a list refresh failure separately from successful installation', async () => {
  await render(true);
  await install();
  api.market.mockRejectedValueOnce(new Error('fixture list unavailable'));
  await act(async () => pending.get(entries[0]!.id)!.finish());
  expect(host.textContent).toContain('fixture list unavailable');
  expect(api.toast).toHaveBeenCalledOnce();
  expect(api.toast).toHaveBeenCalledWith('已安装 Fixture a, 下一 Turn 起生效', { variant: 'success' });
  await act(async () => button(host, '重试').click());
  expect(card().textContent).toContain('已安装');
});

it('rejects duplicate submissions after navigation without blocking another source', async () => {
  await render(true);
  await install();
  await render(false);
  await render(true);
  await act(async () => {
    await useSkillStore.getState().installFromMarket({ source: 'clawhub', slug: 'a' });
    void useSkillStore.getState().installFromMarket({ source: 'skillhub', slug: 'a' });
  });
  expect(api.install).toHaveBeenCalledTimes(2);
  expect(useSkillStore.getState().installingMarketIds).toEqual(new Set(['clawhub:a', 'skillhub:a']));
  await act(async () => pending.get('skillhub:a')!.fail());
  expectInstalling(0);
  await act(async () => pending.get('clawhub:a')!.finish());
  expect(useSkillStore.getState().installingMarketIds.size).toBe(0);
  expect(card().textContent).toContain('已安装');
});

it.each(['success', 'failure'] as const)('ignores an older list request ending with %s after the change event', async outcome => {
  await render(true);
  let finishOld!: (result: SkillMarketList) => void;
  let failOld!: (error: Error) => void;
  api.market.mockImplementationOnce(() => new Promise<SkillMarketList>((resolve, reject) => {
    finishOld = resolve;
    failOld = reject;
  }));
  const oldItems = marketItems();
  await act(async () => button(host, '刷新市场').click());
  installed.add(entries[0]!.id);
  await act(async () => dispatchSystemEvent({ type: 'skills_changed' }));
  expect(card().textContent).toContain('已安装');
  await act(async () => {
    if (outcome === 'success') {
      finishOld({
        items: oldItems,
        nextCursor: null,
        sources: { clawhub: { status: 'ok' }, skillhub: { status: 'ok' } },
      });
    } else {
      failOld(new Error('outdated list failure'));
    }
  });
  expect(card().textContent).toContain('已安装');
  expect(host.textContent).not.toContain('outdated list failure');
});

it('does not reopen a closed detail when its request finishes', async () => {
  await render(true);
  let finishDetail!: (result: Awaited<ReturnType<typeof skillsApi.marketDetail>>) => void;
  api.detail.mockImplementationOnce(() => new Promise(resolve => {
    finishDetail = resolve;
  }));
  await act(async () => card().querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => button(document, '关闭').click());
  await act(async () => finishDetail({
    skill: { ...entries[0]!, description: 'Late detail', files: [], totalSize: 0 },
    sourceStatus: { status: 'ok' },
  }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('refreshes the selected detail instead of the skill whose installation just finished', async () => {
  await render(true);
  await install(0);
  await act(async () => card(1).querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => pending.get(entries[0]!.id)!.finish());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Fixture b');
  expect(dialog.textContent).not.toContain('Fixture a');
  expect(button(dialog, '安装').disabled).toBe(false);
});

it('shows a detail refresh error without turning a successful install into a failure', async () => {
  await render(true);
  await install();
  await act(async () => card().querySelector<HTMLButtonElement>('button')!.click());
  api.detail.mockRejectedValueOnce(new Error('fixture detail unavailable'));
  await act(async () => pending.get(entries[0]!.id)!.finish());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('详情加载失败: fixture detail unavailable');
  expect(api.toast).toHaveBeenCalledOnce();
  expect(api.toast).toHaveBeenCalledWith('已安装 Fixture a, 下一 Turn 起生效', { variant: 'success' });
});

it('refreshes the list and current detail when an installed skill is removed', async () => {
  installed.add(entries[0]!.id);
  await render(true);
  await act(async () => card().querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => button(document.querySelector('[role="dialog"]')!, '卸载').click());

  expect(button(card(), '安装').disabled).toBe(false);
  expect(button(document.querySelector('[role="dialog"]')!, '安装').disabled).toBe(false);
  expect(api.uninstall).toHaveBeenCalledWith({ source: 'clawhub', slug: 'a' });
  expect(api.install).not.toHaveBeenCalled();
  expect(api.toast).toHaveBeenCalledWith('已卸载 Fixture a', { variant: 'success' });
});
