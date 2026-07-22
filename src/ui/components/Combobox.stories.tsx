// 展示并目测验证 Combobox 的筛选、预选、长列表和空结果状态。
import { useState } from 'react';
import { Combobox } from './Combobox.js';
import type { ComboboxOption } from './Combobox.js';

// ── Combobox stories ────────────────────────────────────────────────────────

export default { title: 'Atoms / Combobox' };

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-[var(--ema-bg)] p-8 text-[var(--ema-text-primary)] max-w-sm mx-auto space-y-6">{children}</div>
);

const MODELS: ComboboxOption[] = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { value: 'deepseek-v3',       label: 'DeepSeek V3',       hint: '深度求索' },
  { value: 'qwen3-72b',         label: 'Qwen3 72B',         hint: '通义千问' },
  { value: 'gpt-4o',            label: 'GPT-4o',            hint: 'OpenAI', disabled: true },
  { value: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', hint: 'Anthropic' },
];

export const ModelPicker = (): React.JSX.Element => {
  const [model, setModel] = useState('deepseek-v4-flash');
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">model picker (⌨️ 搜索)</h2>
      <Combobox
        options={MODELS}
        value={model}
        onChange={setModel}
        placeholder="选择模型…"
      />
      <p className="text-xs text-neutral-500">
        当前选中：{model}。输入 "qwen" 筛选，↓↑ 导航，Enter 选择。
      </p>
    </Frame>
  );
};

export const Preselected = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">pre-selected value</h2>
    <Combobox
      options={MODELS}
      value="gpt-4o"
      onChange={() => { /* noop for demo */ }}
    />
    <p className="text-xs text-neutral-500">GPT-4o 已选中但 disabled，不可通过键盘/鼠标改选。</p>
  </Frame>
);

export const ManyOptions = (): React.JSX.Element => {
  const bigList: ComboboxOption[] = Array.from({ length: 50 }, (_, i) => ({
    value: `option-${i}`,
    label: `选项 #${i} — 这是一个很长的选项名`,
  }));
  const [val, setVal] = useState('option-0');
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">50 选项（滚动 + 键盘导航）</h2>
      <Combobox options={bigList} value={val} onChange={setVal} placeholder="输入筛选…" />
    </Frame>
  );
};

export const Empty = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">无匹配</h2>
    <Combobox
      options={MODELS}
      value="deepseek-v4-flash"
      onChange={() => { /* noop */ }}
      placeholder="试输入不存在的模型名…"
    />
  </Frame>
);
