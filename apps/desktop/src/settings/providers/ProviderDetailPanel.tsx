/** ProviderDetailPanel — provider 单能力档位的控制面板：凭据/连接(Base URL)/探活/协议档/模型池；所有控件独立立即提交。 */
import { useState, type JSX, type KeyboardEvent } from 'react';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  Select,
  resolveProviderIconClass,
} from '@ema-agent/ui';
import { useProviderStore } from '../../stores/provider.js';
import {
  PROTOCOL_LABELS,
  providersApi,
  type ModelCapability,
  type ProviderRecord,
} from '../../api/providers.js';
import { PROTOCOLS, PROVIDER_LIMITS, isProtocolForCapability, type Protocol } from '@ema-agent/providers/types';
import { showToast } from '../../lib/toast.js';
import { ProviderModelManager } from './ProviderModelManager.js';

export interface ProviderDetailPanelProps {
  provider:   ProviderRecord;
  capability: ModelCapability;
}

/** 探活只支持有无输入即可验证连通性的能力（tts/stt 的功能验证是试听与转写）。 */
const PROBEABLE: ReadonlySet<ModelCapability> = new Set(['llm', 'embed', 'rerank', 'vision']);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function ProviderDetailPanel({
  provider, capability,
}: ProviderDetailPanelProps): JSX.Element {
  /** null = 未触碰（显示现有 key）；'' = 用户删光（视为删除 key）；非空 = 新 key 草稿。 */
  const [apiKey,       setApiKey]       = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [probing,      setProbing]      = useState(false);
  const [fieldBusy,    setFieldBusy]    = useState(false);

  const capabilityRow = provider.capabilities.find((c) => c.capability === capability);
  const requiresCredentials = provider.authType === 'bearer';
  /** 眼睛开关：开=明文（type text），关=浏览器原生遮蔽（圆点长度=真实 key 长度）。 */
  const [eyeOpen, setEyeOpen] = useState(false);

  const activeProtocol = capabilityRow?.activeProtocol ?? '';
  const activeBaseUrl = capabilityRow?.protocols.find((p) => p.protocol === activeProtocol)?.baseUrl ?? '';
  const [baseUrl, setBaseUrl] = useState(activeBaseUrl);

  const health = provider.health.find((h) => h.capability === capability);
  const [probeOk,    setProbeOk]    = useState<boolean | null>(
    health?.status === 'ok' ? true : null,
  );
  const [probeMsg, setProbeMsg] = useState<string | null>(health?.lastError ?? null);

  // ── Ping 成功顺手同步目录模型进池；模型池 reloadKey bump 触发重载。 ────────────
  const [modelsReloadKey, setModelsReloadKey] = useState(0);

  // ── 字段独立提交：失焦/回车即 PATCH，失败 toast 并回置输入框 ──────────────────

  /** API Key 三态提交：删光 = 删除 key（key: null）；新值 = 替换；同值/未触碰 = 不写。 */
  async function commitApiKey(): Promise<void> {
    if (apiKey === null || fieldBusy) return;
    const value = apiKey.trim();
    if (value === '') {
      if (provider.keyValue === undefined) { setApiKey(null); return; }
      setFieldBusy(true);
      try {
        await providersApi.patch(provider.id, { key: null });
        await useProviderStore.getState().refreshProviders();
        setApiKey(null);
        showToast('密钥已删除', { variant: 'success' });
      } catch (err) {
        showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
      } finally {
        setFieldBusy(false);
      }
      return;
    }
    if (value === provider.keyValue) { setApiKey(null); return; }
    setFieldBusy(true);
    try {
      await providersApi.patch(provider.id, { key: value });
      await useProviderStore.getState().refreshProviders();
      setApiKey(null);
      showToast('密钥已更新', { variant: 'success' });
    } catch (err) {
      showToast(`保存失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setFieldBusy(false);
    }
  }

  /** Base URL：仅当前激活档的地址；非法地址不提交并提示。 */
  async function commitBaseUrl(): Promise<void> {
    const value = baseUrl.trim();
    if (fieldBusy || !activeProtocol || value === activeBaseUrl) return;
    if (!isHttpUrl(value)) {
      showToast('Base URL 必须是 http/https 地址', { variant: 'warning' });
      setBaseUrl(activeBaseUrl);
      return;
    }
    setFieldBusy(true);
    try {
      await providersApi.patch(provider.id, {
        capability: { capability, protocol: activeProtocol as Protocol, baseUrl: value, active: true },
      });
      await useProviderStore.getState().refreshProviders();
      showToast('已更新', { variant: 'success' });
    } catch (err) {
      showToast(`保存失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
      setBaseUrl(activeBaseUrl);
    } finally {
      setFieldBusy(false);
    }
  }

  function handleFieldKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  }

  /** 眼睛只负责切换遮蔽/明文；keyValue 是凭据边界的全文投影，有 key 时输入框直接展示它（受 eyeOpen 控制形态）。 */
  const displayedKey = apiKey ?? (provider.keyValue ?? '');

  /** Ping = 验证连接；llm/vision 成功后顺手同步目录模型进池。 */
  async function handleProbe(): Promise<void> {
    if (!PROBEABLE.has(capability)) return;
    setProbing(true);
    try {
      const result = await providersApi.probe(
        provider.id,
        capability as 'llm' | 'embed' | 'rerank' | 'vision',
      );
      setProbeOk(result.ok);
      setProbeMsg(result.ok ? null : result.error);
      if (result.ok && (capability === 'llm' || capability === 'vision')) {
        await providersApi.refreshModels(provider.id, capability);
        setModelsReloadKey((k) => k + 1);
      }
    } catch (err) {
      setProbeOk(false);
      setProbeMsg('探测失败' + (err instanceof Error ? `: ${err.message}` : ''));
    } finally {
      setProbing(false);
    }
  }

  // ── 协议档管理：切换/删除/新增都立即写后端 ──────────────────────────────────

  const [protocolBusy, setProtocolBusy] = useState(false);
  const [removingProtocol, setRemovingProtocol] = useState<string | null>(null);
  const [addingProtocol, setAddingProtocol] = useState(false);
  const [newProtocol, setNewProtocol] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');

  function slotUrl(proto: string): string {
    return capabilityRow?.protocols.find((p) => p.protocol === proto)?.baseUrl ?? '';
  }

  /** 切换激活档对 Narrative 的影响：目标协议不满足 lightrag 协议锁、且该 provider 被对应模块绑定。 */
  function narrativeConflictOnSwitch(target: string): 'lightrag-llm' | 'lightrag-embed' | null {
    const expected = capability === 'llm'
      ? { module: 'lightrag-llm' as const, protocol: 'openai-llm' }
      : capability === 'embed'
        ? { module: 'lightrag-embed' as const, protocol: 'openai-embed' }
        : null;
    if (!expected || target === expected.protocol) return null;
    const bindings = useProviderStore.getState().bindings;
    return bindings[expected.module]?.providerId === provider.id ? expected.module : null;
  }

  const [switchingProtocol, setSwitchingProtocol] = useState<string | null>(null);

  /** 切换激活档：先查 lightrag 绑定冲突（有冲突先弹窗），确认或无辜后写后端。 */
  async function activateProtocol(proto: string): Promise<void> {
    if (protocolBusy || proto === activeProtocol) return;
    if (narrativeConflictOnSwitch(proto)) {
      setSwitchingProtocol(proto);
      return;
    }
    await doActivateProtocol(proto);
  }

  async function doActivateProtocol(proto: string): Promise<void> {
    setProtocolBusy(true);
    try {
      await providersApi.patch(provider.id, {
        capability: { capability, protocol: proto as Protocol, baseUrl: slotUrl(proto), active: true },
      });
      setBaseUrl(slotUrl(proto));
      await useProviderStore.getState().refreshProviders();
    } catch (err) {
      showToast(`切换失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setProtocolBusy(false);
    }
  }

  /** 切换弹窗确认：先解绑冲突的 lightrag 模块，再执行切换。 */
  async function confirmSwitchProtocol(): Promise<void> {
    const proto = switchingProtocol;
    setSwitchingProtocol(null);
    if (!proto) return;
    const narrativeModule = narrativeConflictOnSwitch(proto);
    if (narrativeModule) {
      await useProviderStore.getState().deleteBinding(narrativeModule);
    }
    await doActivateProtocol(proto);
  }

  /** 删除档对 Narrative 的影响：删的是当前激活档、且该 provider 被 lightrag 对应模块绑定。 */
  function narrativeConflictOf(proto: string): 'lightrag-llm' | 'lightrag-embed' | null {
    if (proto !== activeProtocol) return null;
    const module = capability === 'llm' ? 'lightrag-llm' : capability === 'embed' ? 'lightrag-embed' : null;
    if (!module) return null;
    const bindings = useProviderStore.getState().bindings;
    return bindings[module]?.providerId === provider.id ? module : null;
  }

  async function removeProtocol(proto: string): Promise<void> {
    setRemovingProtocol(null);
    setProtocolBusy(true);
    try {
      const narrativeModule = narrativeConflictOf(proto);
      if (narrativeModule) {
        await useProviderStore.getState().deleteBinding(narrativeModule);
      }
      await providersApi.patch(provider.id, {
        capability: { capability, removedProtocols: [proto as Protocol] },
      });
      await useProviderStore.getState().refreshProviders();
    } catch (err) {
      showToast(`删除失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setProtocolBusy(false);
    }
  }

  /** 可新增的档：词表 ∩ 该能力支持 ∩ 该 Provider 未存档。 */
  const addableProtocols = PROTOCOLS.filter(
    (proto) => isProtocolForCapability(capability, proto)
      && !(capabilityRow?.protocols.some((entry) => entry.protocol === proto) ?? false),
  );

  async function addProtocol(): Promise<void> {
    if (!newProtocol || !newBaseUrl.trim() || protocolBusy) return;
    if (!isHttpUrl(newBaseUrl.trim())) {
      showToast('Base URL 必须是 http/https 地址', { variant: 'warning' });
      return;
    }
    setProtocolBusy(true);
    try {
      await providersApi.patch(provider.id, {
        capability: { capability, protocol: newProtocol as Protocol, baseUrl: newBaseUrl.trim() },
      });
      await useProviderStore.getState().refreshProviders();
      setAddingProtocol(false);
      setNewProtocol('');
      setNewBaseUrl('');
      showToast('已添加协议档', { variant: 'success' });
    } catch (err) {
      showToast(`添加失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setProtocolBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8 pb-6">

      {/* ── 基础配置 ──────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-6 max-w-lg">
        <div>
          <h2 className="text-2xl text-[var(--ema-text-primary)]">基础配置</h2>
          <p className="text-sm text-[var(--ema-text-tertiary)] mt-0.5">每项修改失焦即生效，无需保存</p>
        </div>

        {requiresCredentials && <div className="flex flex-col gap-2">
          <div>
            <div className="text-sm font-medium text-[var(--ema-text-secondary)]">API 密钥</div>
            <div className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">
              API Key for {provider.name}
            </div>
          </div>
          <div className="relative">
            <Input
              type={eyeOpen ? 'text' : 'password'}
              placeholder="sk-..."
              value={displayedKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => void commitApiKey()}
              onKeyDown={handleFieldKeyDown}
              autoComplete="off"
              maxLength={PROVIDER_LIMITS.apiKeyChars}
              className="pr-10"
            />
            <IconButton
              label={eyeOpen ? '隐藏密钥' : '显示密钥'}
              icon={eyeOpen ? 'i-lucide:eye-off' : 'i-lucide:eye'}
              size="sm"
              type="button"
              tabIndex={-1}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              onClick={() => setEyeOpen((v) => !v)}
            />
          </div>
        </div>}
      </section>

      {/* ── 高级配置（协议档与地址一体，默认折叠） ────────────────────────── */}
      <section className="flex flex-col gap-4 max-w-lg">
        <button
          type="button"
          className="flex items-center gap-1.5 text-left outline-none group"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <h2 className="text-2xl text-[var(--ema-text-primary)] group-hover:text-[var(--ema-text-secondary)] transition-colors duration-[var(--ema-duration-base)]">
            高级配置
          </h2>
          <span
            className="i-solar:alt-arrow-down-linear text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-text-secondary)] transition-transform duration-[var(--ema-duration-base)]"
            style={{ transform: advancedOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
            aria-hidden
          />
        </button>

        <div className="ema-collapsible" style={{ gridTemplateRows: advancedOpen ? '1fr' : '0fr' }}>
          <div className="overflow-hidden min-h-0 flex flex-col gap-4 mt-1">
            {/* 协议档：当前档下拉切换；垃圾桶删除当前档（剩一档禁删）；＋新增弹窗。 */}
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-[var(--ema-text-secondary)]">协议</div>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Select
                    value={activeProtocol}
                    onChange={(proto) => void activateProtocol(proto)}
                    options={(capabilityRow?.protocols ?? []).map((slot) => ({
                      value: slot.protocol,
                      label: PROTOCOL_LABELS[slot.protocol] ?? slot.protocol,
                    }))}
                  />
                </div>
                {(capabilityRow?.protocols.length ?? 0) > 1 && (
                  <IconButton
                    label="删除当前协议档"
                    icon="i-lucide:trash-2"
                    variant="default"
                    size="sm"
                    type="button"
                    disabled={protocolBusy}
                    onClick={() => setRemovingProtocol(activeProtocol)}
                  />
                )}
                {addableProtocols.length > 0 && (
                  <IconButton
                    label="增加新协议"
                    icon="i-solar:add-circle-bold-duotone"
                    variant="default"
                    size="sm"
                    type="button"
                    disabled={protocolBusy}
                    onClick={() => setAddingProtocol(true)}
                  />
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div>
                <div className="text-sm font-medium text-[var(--ema-text-secondary)]">Base URL</div>
                <div className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">API 根地址（如 https://api.deepseek.com，不带 /embeddings 等路径；失焦即生效）</div>
              </div>
              <Input
                placeholder={activeBaseUrl || 'https://...'}
                value={baseUrl}
                maxLength={PROVIDER_LIMITS.baseUrlChars}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => void commitBaseUrl()}
                onKeyDown={handleFieldKeyDown}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── 验证状态条（错误全文换行铺开，不截断；Ping 按钮固定右侧） ──────── */}
      {probeOk === false && probeMsg && (
        <div className="flex items-center justify-between gap-3 rounded-lg
                        bg-[var(--ema-danger-muted)] border border-[var(--ema-danger)]
                        px-3 py-2 text-sm text-[var(--ema-danger-text)] max-w-lg">
          <div className="flex items-start gap-2 min-w-0 flex-1">
            <span className="i-solar:danger-circle-linear shrink-0 mt-0.5" aria-hidden />
            <span className="break-all whitespace-pre-wrap min-w-0">{probeMsg}</span>
          </div>
          {PROBEABLE.has(capability) && (
            <Button
              variant="danger"
              size="sm"
              loading={probing}
              disabled={probing}
              type="button"
              className="shrink-0"
              onClick={() => void handleProbe()}
            >
              Ping API
            </Button>
          )}
        </div>
      )}
      {probeOk !== false && (
        <Callout variant="info" className="max-w-lg">
          <div className="flex items-center justify-between">
            <span>{probeOk === true ? '配置验证通过' : '配置部分验证'}</span>
            {PROBEABLE.has(capability) && (
              <Button
                variant="ghost"
                size="sm"
                loading={probing}
                disabled={probing}
                type="button"
                onClick={() => void handleProbe()}
              >
                Ping API
              </Button>
            )}
          </div>
        </Callout>
      )}

      {/* ── 模型池 ───────────────────────────────────────────────────────────── */}
      <div className="border-t border-[var(--ema-border)]" />
      <ProviderModelManager
        providerId={provider.id}
        capability={capability}
        iconKey={resolveProviderIconClass(provider.iconId)}
        reloadKey={modelsReloadKey}
      />

      {/* 切换激活档：目标协议不满足 lightrag 协议锁时先告知，确认即解绑并切换。 */}
      <ConfirmDialog
        open={switchingProtocol !== null}
        message={switchingProtocol
          ? `该 Provider 正被 ${capability === 'llm' ? 'LightRAG LLM' : 'LightRAG 嵌入'} 绑定使用（仅支持 ${capability === 'llm' ? 'openai-llm' : 'openai-embed'} 协议）。切换到 "${PROTOCOL_LABELS[switchingProtocol] ?? switchingProtocol}" 后该绑定会失效并自动解除。确定切换吗？`
          : ''}
        confirmText="解绑并切换"
        onConfirm={() => void confirmSwitchProtocol()}
        onCancel={() => setSwitchingProtocol(null)}
      />

      {/* 删除协议档：对 Narrative 绑定有协议锁影响时先告知，确认即解绑并删除。 */}
      <ConfirmDialog
        open={removingProtocol !== null}
        message={removingProtocol
          ? (() => {
              const narrativeModule = narrativeConflictOf(removingProtocol);
              return narrativeModule
                ? `该协议档被 ${narrativeModule === 'lightrag-llm' ? 'LightRAG LLM' : 'LightRAG 嵌入'} 绑定使用，删除后该绑定会失效并自动解除。确定删除 "${PROTOCOL_LABELS[removingProtocol] ?? removingProtocol}" 协议档吗？`
                : `确定删除 "${PROTOCOL_LABELS[removingProtocol] ?? removingProtocol}" 协议档吗？`;
            })()
          : ''}
        confirmText="删除"
        onConfirm={() => { if (removingProtocol) void removeProtocol(removingProtocol); }}
        onCancel={() => setRemovingProtocol(null)}
      />

      {/* 增加新协议档：只允许词表内、该能力支持且该 Provider 未存档的协议。 */}
      <Dialog
        open={addingProtocol}
        onOpenChange={(open) => { if (!open) { setAddingProtocol(false); setNewProtocol(''); setNewBaseUrl(''); } }}
        title="增加新协议"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-[var(--ema-text-secondary)]">协议</div>
            <Select
              value={newProtocol}
              onChange={setNewProtocol}
              placeholder="选择协议"
              options={addableProtocols.map((proto) => ({
                value: proto,
                label: PROTOCOL_LABELS[proto] ?? proto,
              }))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-[var(--ema-text-secondary)]">Base URL（必填）</div>
            <Input
              placeholder="https://..."
              value={newBaseUrl}
              maxLength={PROVIDER_LIMITS.baseUrlChars}
              onChange={(e) => setNewBaseUrl(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setAddingProtocol(false)}>取消</Button>
            <Button
              variant="primary"
              size="sm"
              loading={protocolBusy}
              disabled={!newProtocol || !newBaseUrl.trim() || protocolBusy}
              onClick={() => void addProtocol()}
            >
              确认
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
