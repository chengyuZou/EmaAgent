/** ProviderCreatePanel — 按能力分区的自建 Provider 创建（id/名称/连接方式/协议/Base URL/Key）。 */
import { useState, type FormEvent, type JSX } from 'react';
import { Button, Field, IconButton, Input, Select } from '@ema-agent/ui';
import { isProtocolForCapability, PROTOCOLS, PROVIDER_LIMITS, type Protocol } from '@ema-agent/providers/types';
import { PROVIDER_ICON_ID_PATTERN } from '@ema-agent/ui';
import { useProviderStore } from '../../stores/provider.js';
import { PROTOCOL_LABELS, type ModelCapability } from '../../api/providers.js';
import { showToast } from '../../lib/toast.js';

/** 该能力支持的协议词表（每个能力词表至少一档，空 = 调用方传了非法能力）。 */
function protocolsOf(capability: ModelCapability): Protocol[] {
  const protocols = PROTOCOLS.filter((p) => isProtocolForCapability(capability, p));
  if (protocols.length === 0) throw new Error(`能力 ${capability} 没有可用协议`);
  return protocols;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function ProviderCreatePanel({ capability, label, onCancel, onCreated }: {
  capability: ModelCapability;
  label: string;
  onCancel(): void;
  onCreated(providerId: string): void;
}): JSX.Element {
  const [id, setId]         = useState('');
  const [name, setName]     = useState('');
  const [iconId, setIconId] = useState('');
  const [authType, setAuthType] = useState<'bearer' | 'none'>('bearer');
  const [protocol, setProtocol] = useState<Protocol>(() => protocolsOf(capability)[0]!);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requiresKey = authType === 'bearer';
  const idValid = /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(id.trim());
  const iconIdTrimmed = iconId.trim();
  const iconIdValid = iconIdTrimmed === '' || PROVIDER_ICON_ID_PATTERN.test(iconIdTrimmed);
  const submittable = !submitting
    && idValid
    && iconIdValid
    && name.trim().length > 0
    && isHttpUrl(baseUrl.trim())
    && (!requiresKey || apiKey.trim().length > 0);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!submittable) return;
    setSubmitting(true);
    try {
      const created = await useProviderStore.getState().createProvider({
        id: id.trim(),
        name: name.trim(),
        ...(iconIdTrimmed ? { iconId: iconIdTrimmed } : {}),
        authType,
        ...(apiKey.trim() ? { key: apiKey.trim() } : {}),
        capability: {
          capability,
          protocol: protocol as Protocol,
          baseUrl: baseUrl.trim(),
        },
      });
      showToast('已创建', { variant: 'success' });
      onCreated(created.id);
    } catch (err: unknown) {
      showToast(`创建失败: ${err instanceof Error ? err.message : 'Unknown'}`, { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex items-center gap-3">
        <IconButton
          label="返回服务来源"
          icon="i-solar:alt-arrow-left-line-duotone"
          size="sm"
          className="-ml-1.5"
          onClick={onCancel}
        />
        <h2 className="text-xl font-semibold text-[var(--ema-text-primary)]">添加{label}服务来源</h2>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-6 max-w-lg">
        <Field
          label="Provider ID"
          required
          description="语义 ID（如 company-gateway），创建后不可改；绑定、模型与选择器都以它显示。"
          error={id.trim() && !idValid ? '只能包含字母、数字、中划线、下划线，且不超过 64 字符' : undefined}
        >
          <Input
            placeholder="company-gateway"
            value={id}
            maxLength={PROVIDER_LIMITS.idChars}
            onChange={(e) => setId(e.target.value)}
          />
        </Field>

        <Field label="名称" required>
          <Input
            placeholder="例如：公司网关、本地 vLLM"
            value={name}
            maxLength={PROVIDER_LIMITS.nameChars}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field
          label="图标（可空）"
          description="lobe-icons 类名，如 i-lobe-icons:qwen；留空用默认图标。不支持 emoji"
          error={iconIdTrimmed && !iconIdValid ? '仅支持 uno 图标类名（i-xxx:yyy 形态）' : undefined}
        >
          <Input
            placeholder="i-lobe-icons:deepseek"
            value={iconId}
            onChange={(e) => setIconId(e.target.value)}
            className="font-mono"
          />
        </Field>

        <Field label="连接方式" required>
          <Select
            value={authType}
            onChange={(value) => setAuthType(value as 'bearer' | 'none')}
            options={[
              { value: 'bearer', label: '需要 API Key（Bearer）' },
              { value: 'none', label: '无需密钥（本地服务）' },
            ]}
          />
        </Field>

        <Field
          label="协议"
          required
          description="该能力支持的协议；协议决定请求格式，Base URL 跟它一起生效。"
        >
          <Select
            value={protocol}
            onChange={(value) => setProtocol(value as Protocol)}
            options={protocolsOf(capability).map((proto) => ({
              value: proto,
              label: PROTOCOL_LABELS[proto] ?? proto,
            }))}
          />
        </Field>

        <Field
          label="Base URL"
          required
          description="API 根地址，如 https://api.deepseek.com 或 http://localhost:8000/v1（不要带 /embeddings 等端点路径）"
        >
          <Input
            placeholder="https://..."
            value={baseUrl}
            maxLength={PROVIDER_LIMITS.baseUrlChars}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>

        {requiresKey && (
          <Field label="API 密钥" required>
            <Input
              type="password"
              placeholder="sk-..."
              value={apiKey}
              autoComplete="off"
              maxLength={PROVIDER_LIMITS.apiKeyChars}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ema-border)] pt-4">
          <span className="text-xs text-[var(--ema-text-tertiary)]">
            创建后协议档与地址可在配置页继续调整
          </span>
          <Button type="submit" variant="primary" size="sm" loading={submitting} disabled={!submittable}>
            创建
          </Button>
        </div>
      </form>
    </div>
  );
}
