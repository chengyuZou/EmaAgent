import { useState } from 'react';
import { Textarea } from './Textarea.js';
import { IconButton } from './IconButton.js';

// ── Textarea stories ────────────────────────────────────────────────────────

export default { title: 'Atoms / Textarea' };

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-neutral-950 p-8 text-white max-w-xl mx-auto">{children}</div>
);

export const Basic = (): React.JSX.Element => {
  const [text, setText] = useState('');
  return (
    <Frame>
      <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">basic auto-grow</h2>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息…"
      />
      <p className="mt-2 text-xs text-neutral-500">高度跟着内容长，达到 maxRows=8 后内部滚动。</p>
    </Frame>
  );
};

export const WithEmbeddedSend = (): React.JSX.Element => {
  const [text, setText]   = useState('');
  const [sending, setSending] = useState(false);

  const hasContent = text.trim().length > 0;
  const handleSend = (): void => {
    if (!hasContent) return;
    setSending(true);
    setTimeout(() => { setSending(false); setText(''); }, 1200);
  };

  return (
    <Frame>
      <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">
        circular send button (frontend-skeleton §5)
      </h2>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息… 按 Ctrl+Enter 发送"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSend();
          }
        }}
        embeddedAction={
          <IconButton
            variant={hasContent ? 'primary' : 'default'}
            icon="i-mdi:send"
            label="发送 (Ctrl+Enter)"
            disabled={!hasContent}
            loading={sending}
            onClick={handleSend}
          />
        }
      />
      <p className="mt-2 text-xs text-neutral-500">
        圆形按钮位于 textarea 内部右下角。空文本时按钮变 default；有内容时变 primary 高亮。
      </p>
    </Frame>
  );
};

export const ErrorState = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">error state</h2>
    <Textarea
      defaultValue="超过 1000 字会失败"
      error
      onChange={() => { /* noop */ }}
    />
  </Frame>
);

export const Disabled = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">disabled</h2>
    <Textarea
      defaultValue="只读内容"
      disabled
      onChange={() => { /* noop */ }}
    />
  </Frame>
);
