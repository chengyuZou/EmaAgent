import type { JSX } from 'react';
import { Callout, Spinner } from '@ema-agent/ui';
import { NumberSetting } from '../parameters/controls/NumberSetting.js';
import { PercentSetting } from '../parameters/controls/PercentSetting.js';
import { useSettingValues } from '../parameters/useSettingValues.js';
import { SettingsCard, SettingsSection } from '../shared/SettingItem.js';

const DEFAULT_TOP_K = 'kb.retrieval.defaultTopK';
const ALPHA = 'kb.retrieval.alpha';
const RERANK_BLEND_WEIGHT = 'kb.retrieval.rerankBlendWeight';
const RESULT_MAX_CHARS = 'kb.retrieval.resultMaxChars';

export function KnowledgeSettings(): JSX.Element {
  const settings = useSettingValues();
  if (settings.loading) return <div className="flex h-48 items-center justify-center"><Spinner size="md" /></div>;
  if (settings.error) return <Callout variant="danger">Knowledge Base 参数读取失败: {settings.error}</Callout>;
  const number = (key: string): number => requiredNumber(settings.values, key);

  return (
    <SettingsSection icon="i-lucide:database" title="检索参数" description="Tool 检索结果的排序与体积">
      <SettingsCard>
        <NumberSetting title="默认命中条数" hint="Tool 没有指定 topK 时返回的结果数量." apply={settings.apply(DEFAULT_TOP_K)} value={number(DEFAULT_TOP_K)} unit="条" onSave={value => settings.save(DEFAULT_TOP_K, value)} onReset={() => settings.reset(DEFAULT_TOP_K)} />
        <PercentSetting title="向量检索权重" hint="稠密向量路在 RRF 融合中的权重." apply={settings.apply(ALPHA)} value={number(ALPHA)} onSave={value => settings.save(ALPHA, value)} onReset={() => settings.reset(ALPHA)} />
        <PercentSetting title="重排序权重" hint="最终排序中 rerank 分数所占权重." apply={settings.apply(RERANK_BLEND_WEIGHT)} value={number(RERANK_BLEND_WEIGHT)} onSave={value => settings.save(RERANK_BLEND_WEIGHT, value)} onReset={() => settings.reset(RERANK_BLEND_WEIGHT)} />
        <NumberSetting title="结果字符预算" hint="送回模型的检索正文最多包含多少字符." apply={settings.apply(RESULT_MAX_CHARS)} value={number(RESULT_MAX_CHARS)} unit="字符" onSave={value => settings.save(RESULT_MAX_CHARS, value)} onReset={() => settings.reset(RESULT_MAX_CHARS)} />
      </SettingsCard>
    </SettingsSection>
  );
}

function requiredNumber(values: ReadonlyMap<string, unknown>, key: string): number {
  const value = values.get(key);
  if (typeof value !== 'number') throw new Error(`参数 ${key} 没有返回数字值`);
  return value;
}
