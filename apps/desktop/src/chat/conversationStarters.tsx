// 新对话与尚无消息的会话共用四个快捷动作, 只回填草稿, 不直接发送.
import type { CSSProperties, JSX } from 'react';

const QUICK_PROMPTS = [
  { icon: 'i-lucide:code', label: '梳理项目结构', prompt: '梳理一下当前项目的结构' },
  { icon: 'i-lucide:palette', label: '设计一段交互', prompt: '帮我设计一段界面交互' },
  { icon: 'i-lucide:list-todo', label: '整理工作计划', prompt: '帮我整理一份今天的工作计划' },
  { icon: 'i-lucide:sparkles', label: '先聊一会儿', prompt: '先陪我聊一会儿' },
] as const;

export function ConversationStarters({ onChoose }: { onChoose(prompt: string): void }): JSX.Element {
  return (
    <div className="ema-empty-state">
      <div className="ema-empty-state-prompts" aria-label="开始对话的快捷动作">
        {QUICK_PROMPTS.map((item, index) => (
          <button
            key={item.label}
            type="button"
            className="ema-empty-state-prompt ema-material-card ema-stagger-in focus-ring"
            style={{ '--stagger-i': index } as CSSProperties}
            onClick={() => onChoose(item.prompt)}
          >
            <span className={`${item.icon} shrink-0 text-xl`} aria-hidden />
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
