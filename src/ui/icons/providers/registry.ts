// 将稳定的 Provider 图标身份映射到 UI 图标库，业务定义无需感知 UnoCSS 或具体图标实现。

const FALLBACK_PROVIDER_ICON = 'i-solar:box-bold-duotone';

const PROVIDER_ICONS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'i-lobe-icons:claude',
  dashscope: 'i-lobe-icons:alibabacloud',
  deepseek: 'i-lobe-icons:deepseek',
  fireworks: 'i-lobe-icons:fireworks',
  gemini: 'i-lobe-icons:gemini',
  'gpt-sovits': 'i-lobe-icons:huggingface',
  groq: 'i-lobe-icons:groq',
  jina: 'i-lobe-icons:jina',
  lmstudio: 'i-lobe-icons:lmstudio',
  mistral: 'i-lobe-icons:mistral',
  moonshot: 'i-lobe-icons:moonshot',
  ollama: 'i-lobe-icons:ollama',
  openai: 'i-lobe-icons:openai',
  openrouter: 'i-lobe-icons:openrouter',
  perplexity: 'i-lobe-icons:perplexity',
  siliconflow: 'i-lobe-icons:siliconcloud',
  together: 'i-lobe-icons:together',
  xai: 'i-lobe-icons:xai',
  zhipu: 'i-lobe-icons:zhipu',
});

export function resolveProviderIconClass(iconId: string | undefined): string {
  if (!iconId) return FALLBACK_PROVIDER_ICON;
  return PROVIDER_ICONS[iconId] ?? FALLBACK_PROVIDER_ICON;
}

/**
 * 注册表涉及的全部图标类名。iconKey 是运行时字符串（来自 Server API），静态扫描
 * 看不到，UnoCSS safelist 必须从这里同源推导，不得在消费方另抄一份。
 */
export const PROVIDER_ICON_CLASS_SAFELIST: readonly string[] = Object.freeze([
  FALLBACK_PROVIDER_ICON,
  ...Object.values(PROVIDER_ICONS),
]);
