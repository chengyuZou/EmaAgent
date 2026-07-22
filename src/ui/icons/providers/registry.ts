// 将稳定的 Provider 图标身份映射到 UI 图标库，业务定义无需感知 UnoCSS 或具体图标实现。
import type { ProviderIconClasses, ProviderIconVariant } from './types.js';

const FALLBACK_PROVIDER_ICON: ProviderIconClasses = {
  default: 'i-solar:box-bold-duotone',
  color: 'i-solar:box-bold-duotone',
};

const PROVIDER_ICONS: Readonly<Record<string, ProviderIconClasses>> = Object.freeze({
  anthropic: providerIcon('claude'),
  dashscope: providerIcon('alibabacloud'),
  deepseek: providerIcon('deepseek'),
  fireworks: providerIcon('fireworks'),
  gemini: providerIcon('gemini'),
  'gpt-sovits': providerIcon('huggingface'),
  groq: providerIcon('groq'),
  jina: providerIcon('jina'),
  lmstudio: providerIcon('lmstudio'),
  mistral: providerIcon('mistral'),
  moonshot: providerIcon('moonshot'),
  ollama: providerIcon('ollama'),
  openai: providerIcon('openai'),
  openrouter: providerIcon('openrouter'),
  perplexity: providerIcon('perplexity'),
  siliconflow: providerIcon('siliconcloud'),
  together: providerIcon('together'),
  xai: providerIcon('xai'),
  zhipu: providerIcon('zhipu'),
});

function providerIcon(lobeId: string): ProviderIconClasses {
  return {
    default: `i-lobe-icons:${lobeId}`,
    color: `i-lobe-icons:${lobeId}-color`,
  };
}

export function resolveProviderIconClass(
  iconId: string | undefined,
  variant: ProviderIconVariant = 'default',
): string {
  if (!iconId) return FALLBACK_PROVIDER_ICON[variant];
  return (PROVIDER_ICONS[iconId] ?? FALLBACK_PROVIDER_ICON)[variant];
}
