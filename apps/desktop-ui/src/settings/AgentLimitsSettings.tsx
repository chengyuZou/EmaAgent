// Agent 资源上限设置(agent.limits):常用项直出、专家项折叠;即存,下一轮对话生效。
import { Spinner } from '@ema-agent/ui';
import type { JSX } from 'react';
import { NumberField } from './NumberField.js';
import { AdvancedSettings, SaveStateIndicator, SettingItem, SettingsCard, SettingsSection } from './SettingItem.js';
import { useObjectSetting } from './useObjectSetting.js';

/** 与 src/agent/settings.ts 同形;desktop-ui 不依赖 agent 包,本地镜像。 */
interface AgentLimitsValue {
  chatMaxIterations: number;
  workMaxIterations: number;
  maxToolCalls: number;
  maxSubagents: number;
  maxConcurrentSubagents: number;
}

export function AgentLimitsSettings(): JSX.Element {
  const { value, saveState, update } = useObjectSetting<AgentLimitsValue>('agent.limits');

  return (
    <SettingsSection
      icon="i-solar:cpu-bold-duotone"
      title="Agent"
      description="模型执行任务时的资源上限,调大更能扛复杂任务,也更费 Token 与资源"
      applyNote="下一轮对话生效"
      trailing={<SaveStateIndicator state={saveState} />}
    >
      {value === null ? (
        <div className="flex justify-center py-4"><Spinner size="sm" /></div>
      ) : (
        <SettingsCard>
          <SettingItem
            title="聊天模式迭代上限"
            hint="聊天时一次回复最多思考-行动几轮,调大更能完成复杂请求"
          >
            <NumberField value={value.chatMaxIterations} min={1} max={30} onCommit={(v) => update({ chatMaxIterations: v })} />
          </SettingItem>
          <SettingItem
            title="工作模式迭代上限"
            hint="干活模式一次任务的循环上限,超限会安全停下"
          >
            <NumberField value={value.workMaxIterations} min={1} max={100} onCommit={(v) => update({ workMaxIterations: v })} />
          </SettingItem>
          <SettingItem
            title="同时运行的子智能体"
            hint="并行干活的子智能体数量,调大更快但更占资源"
          >
            <NumberField value={value.maxConcurrentSubagents} min={1} max={8} onCommit={(v) => update({ maxConcurrentSubagents: v })} />
          </SettingItem>
          <AdvancedSettings>
            <SettingItem
              title="单轮工具调用上限"
              hint="一次任务允许调用工具的总次数"
            >
              <NumberField value={value.maxToolCalls} min={1} max={512} onCommit={(v) => update({ maxToolCalls: v })} />
            </SettingItem>
            <SettingItem
              title="单轮子智能体总数"
              hint="一次任务最多开启的子智能体个数,不能小于同时运行数"
            >
              <NumberField value={value.maxSubagents} min={1} max={32} onCommit={(v) => update({ maxSubagents: v })} />
            </SettingItem>
          </AdvancedSettings>
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
