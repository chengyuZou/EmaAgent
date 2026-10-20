// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { ProviderModelManager } from '../src/settings/providers/ProviderModelManager.js';
import { ProviderDetailPanel } from '../src/settings/providers/ProviderDetailPanel.js';
import { ProviderCreatePanel } from '../src/settings/providers/ProviderCreatePanel.js';
import { dispatchSystemEvent } from '../src/lib/events/systemEventDispatcher.js';
import { useProviderStore } from '../src/stores/provider.js';
import type { ProviderDetail, ProviderModelRecord } from '../src/api/providers.js';

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  setModelEnabled: vi.fn(),
  probe: vi.fn(),
  refreshModels: vi.fn(),
  patch: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../src/api/providers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api/providers.js')>(),
  providersApi: api,
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));

const model: ProviderModelRecord = {
  providerId: 'fixture', modelId: 'vision-model', capability: 'vision',
  name: 'Vision model', enabled: true, source: 'user',
  contextWindow: 8000, maxOutput: 1024, reasoning: false,
  toolCall: false, inputImage: true, temperature: true,
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  api.listModels.mockResolvedValue([model]);
  useProviderStore.setState({ bindings: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps the model card mounted while the model-change event reloads its enabled state', async () => {
  await act(async () => root.render(
    <TooltipProvider><ProviderModelManager providerId="fixture" capability="vision" /></TooltipProvider>,
  ));
  const card = host.querySelector<HTMLElement>('[role="button"]')!;
  expect(card.textContent).toContain('Vision model');
  let finish!: (rows: ProviderModelRecord[]) => void;
  api.listModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  api.setModelEnabled.mockImplementationOnce(async () => {
    dispatchSystemEvent({ type: 'provider_models_changed', providerId: 'fixture' });
    return { ...model, enabled: false };
  });
  await act(async () => card.click());
  expect(api.setModelEnabled).toHaveBeenCalledWith('fixture', 'vision-model', 'vision', false);
  expect(host.contains(card)).toBe(true);
  await act(async () => finish([{ ...model, enabled: false }]));
  expect(host.contains(card)).toBe(true);
  expect(card.hasAttribute('data-selected')).toBe(false);
});

it('shows a saved failed probe when opening the provider rather than partial validation', async () => {
  const provider = {
    id: 'fixture', name: 'Fixture', authType: 'none',
    capabilities: [{
      capability: 'vision', activeProtocol: 'openai-llm',
      protocols: [{ protocol: 'openai-llm', baseUrl: 'https://fixture.test/v1' }],
    }],
    health: [{
      capability: 'vision', status: 'failed', lastProbedAt: 1,
      latencyMs: 2, lastError: '400 Model does not exist',
    }],
  } as ProviderDetail;
  await act(async () => root.render(
    <TooltipProvider><ProviderDetailPanel provider={provider} capability="vision" /></TooltipProvider>,
  ));
  expect(host.textContent).toContain('400 Model does not exist');
  expect(host.textContent).not.toContain('配置部分验证');

  await act(async () => root.render(
    <TooltipProvider>
      <ProviderDetailPanel provider={{ ...provider, health: [] }} capability="vision" />
    </TooltipProvider>,
  ));
  expect(host.textContent).not.toContain('400 Model does not exist');
  expect(host.textContent).toContain('尚未验证当前连接');
});

it('sends null when clearing the catalog ID and retains the model card', async () => {
  vi.spyOn(useProviderStore.getState(), 'refreshProviders').mockResolvedValue();
  const provider: ProviderDetail = {
    id: 'fixture', name: 'Fixture', authType: 'none',
    capabilities: [{
      capability: 'vision', activeProtocol: 'openai-llm', modelsDevId: 'siliconflow-cn',
      protocols: [{ protocol: 'openai-llm', baseUrl: 'https://fixture.test/v1' }],
    }],
    health: [],
  };
  await act(async () => root.render(
    <TooltipProvider><ProviderDetailPanel provider={provider} capability="vision" /></TooltipProvider>,
  ));
  const input = host.querySelector<HTMLInputElement>('input[placeholder="siliconflow-cn"]')!;
  await act(async () => {
    input.value = '';
    Simulate.change(input);
  });
  await act(async () => Simulate.blur(input));
  expect(api.patch).toHaveBeenCalledWith('fixture', {
    capability: { capability: 'vision', modelsDevId: null },
  });
  expect(host.textContent).toContain('Vision model');
});

it.each(['llm', 'vision'] as const)('includes a catalog ID when creating a %s provider', async capability => {
  const create = vi.spyOn(useProviderStore.getState(), 'createProvider')
    .mockResolvedValue({ id: 'custom' } as ProviderDetail);
  await act(async () => root.render(
    <ProviderCreatePanel capability={capability} label={capability} onCancel={vi.fn()} onCreated={vi.fn()} />,
  ));
  const fields = [
    ['Provider ID', 'custom'],
    ['名称', 'Custom'],
    ['Base URL', 'https://fixture.test/v1'],
    ['API 密钥', 'fixture-key'],
    ['models.dev ID (可空)', 'siliconflow-cn'],
  ];
  for (const [name, value] of fields) {
    const label = [...host.querySelectorAll('label')].find(entry => entry.textContent?.startsWith(name!));
    const input = document.getElementById(label!.htmlFor) as HTMLInputElement;
    await act(async () => {
      input.value = value!;
      Simulate.change(input);
    });
  }
  await act(async () => Simulate.submit(host.querySelector('form')!));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    id: 'custom',
    capability: expect.objectContaining({ capability, modelsDevId: 'siliconflow-cn' }),
  }));
});
