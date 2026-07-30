// 知识库检索参数设置(kb.retrieval):命中数与两个混合权重直出,正文预算折叠;即存,立即生效。
import { Slider, Spinner } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from './NumberField.js';
import { AdvancedSettings, SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from './SettingItem.js';
import { useObjectSetting } from './useObjectSetting.js';

/** 与 src/knowledge/settings.ts 的 KnowledgeRetrievalSettings 同形;desktop-ui 不依赖 knowledge 包,本地镜像。 */
interface KbRetrievalValue {
  defaultTopK: number;
  alpha: number;
  rerankBlendWeight: number;
  resultMaxChars: number;
}

const RATIO_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  .map((value) => ({ value, label: String(value) }));

export function KbRetrievalSettings(): JSX.Element {
  const { value, saveState, update } = useObjectSetting<KbRetrievalValue>('kb.retrieval');

  return (
    <SettingsSection
      icon="i-solar:magnifer-bold-duotone"
      title="检索参数"
      description="知识库检索的命中数量与排序偏好,保存后立即生效"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="默认命中数"
            hint="每次检索返回多少条结果,调大信息更全但更占上下文"
          >
            <NumberField value={value.defaultTopK} min={1} max={20} onCommit={(v) => update({ defaultTopK: v })} />
          </SettingItem>
          <SettingItem
            title="语义检索权重"
            hint="越高越依赖语义相似度,越低越依赖关键词精确匹配"
          >
            <span className="w-36">
              <Slider
                value={value.alpha}
                steps={RATIO_STEPS}
                hideLabels
                onChange={(alpha) => update({ alpha: Number(alpha.toFixed(1)) })}
              />
            </span>
            <span className="w-8 text-right text-[11px] tabular-nums text-[var(--ema-text-secondary)]">
              {value.alpha.toFixed(1)}
            </span>
          </SettingItem>
          <SettingItem
            title="重排序权重"
            hint="最终排序中重排序模型的话语权,剩余部分由召回顺序决定"
          >
            <span className="w-36">
              <Slider
                value={value.rerankBlendWeight}
                steps={RATIO_STEPS}
                hideLabels
                onChange={(rerankBlendWeight) => update({ rerankBlendWeight: Number(rerankBlendWeight.toFixed(1)) })}
              />
            </span>
            <span className="w-8 text-right text-[11px] tabular-nums text-[var(--ema-text-secondary)]">
              {value.rerankBlendWeight.toFixed(1)}
            </span>
          </SettingItem>
          <AdvancedSettings>
            <SettingItem
              title="结果正文预算"
              hint="喂给模型的检索正文总字数上限,超出部分只显示引用卡"
            >
              <NumberField value={value.resultMaxChars} min={1000} max={50000} unit="字符" onCommit={(v) => update({ resultMaxChars: v })} />
            </SettingItem>
          </AdvancedSettings>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
