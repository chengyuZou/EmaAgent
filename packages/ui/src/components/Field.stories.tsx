import { useState } from 'react';
import { Field } from './Field.js';
import { Input } from './Input.js';
import { Textarea } from './Textarea.js';
import { Select } from './Select.js';

// ── Field stories ───────────────────────────────────────────────────────────

export default { title: 'Atoms / Field' };

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-neutral-950 p-8 text-white max-w-md mx-auto space-y-6">{children}</div>
);

export const WithInput = (): React.JSX.Element => {
  const [val, setVal] = useState('');
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">Field + Input</h2>
      <Field
        label="API 地址"
        description="你的 OpenAI 兼容服务的 base URL"
        required
        inputId="api-url"
      >
        <Input id="api-url" value={val} onChange={(e) => setVal(e.target.value)} placeholder="https://api.openai.com/v1" />
      </Field>
    </Frame>
  );
};

export const WithError = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">with error</h2>
    <Field
      label="Token 上限"
      description="不能超过模型的最大上下文"
      error="上限必须为数字"
      required
    >
      <Input defaultValue="abc" error />
    </Field>
  </Frame>
);

export const WithTextarea = (): React.JSX.Element => {
  const [bio, setBio] = useState('');
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">Field + Textarea</h2>
      <Field label="角色简介" description="对你的 AI 角色的简短描述">
        <Textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Ema 是一个……" maxRows={5} minRows={2} />
      </Field>
    </Frame>
  );
};

export const WithSelect = (): React.JSX.Element => {
  const [mode, setMode] = useState('chat');
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">Field + Select</h2>
      <Field label="默认 Mode" description="新会话启动时用哪个 mode">
        <Select
          value={mode}
          onChange={setMode}
          options={[
            { value: 'chat',      label: '💬 聊天' },
            { value: 'narrative', label: '📖 叙事' },
            { value: 'agent',     label: '🛠 Agent' },
          ]}
        />
      </Field>
    </Frame>
  );
};

export const Minimal = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">minimal (no label / desc)</h2>
    <Field>
      <Input placeholder="只有输入框，没有 label..." />
    </Field>
  </Frame>
);
