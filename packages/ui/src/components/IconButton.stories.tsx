// 展示并目测验证 IconButton 的外观、尺寸和交互状态。
import { useState } from 'react';
import { IconButton } from './IconButton.js';
import type { IconButtonVariant, IconButtonSize } from './IconButton.js';

// ── IconButton stories ──────────────────────────────────────────────────────

export default {
  title: 'Atoms / IconButton',
};

const VARIANTS: IconButtonVariant[] = ['default', 'primary', 'danger'];
const SIZES:    IconButtonSize[]    = ['sm', 'md', 'lg'];

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-[var(--ema-bg)] p-8 text-[var(--ema-text-primary)]">{children}</div>
);

export const Variants = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">variants</h2>
    <div className="flex flex-wrap items-center gap-3">
      {VARIANTS.map((v) => (
        <IconButton key={v} variant={v} icon="i-mdi:chat" label={`${v} chat`} />
      ))}
    </div>
  </Frame>
);

export const Sizes = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">sizes</h2>
    <div className="flex flex-wrap items-center gap-3">
      {SIZES.map((s) => (
        <IconButton key={s} size={s} icon="i-mdi:send" label={`size ${s}`} />
      ))}
    </div>
  </Frame>
);

export const ToggledState = (): React.JSX.Element => {
  const [pinned,     setPinned]     = useState(true);
  const [muted,      setMuted]      = useState(false);
  const [ttsOn,      setTtsOn]      = useState(true);

  return (
    <Frame>
      <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">
        toggled state (click to flip)
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <IconButton
          variant="primary"
          icon={pinned ? 'i-mdi:pin' : 'i-mdi:pin-outline'}
          label={pinned ? '取消置顶' : '置顶'}
          toggled={pinned}
          onClick={() => setPinned(!pinned)}
        />
        <IconButton
          icon={muted ? 'i-mdi:microphone-off' : 'i-mdi:microphone'}
          label={muted ? '取消静音' : '静音'}
          toggled={muted}
          onClick={() => setMuted(!muted)}
        />
        <IconButton
          icon="i-mdi:volume-high"
          label="TTS"
          toggled={ttsOn}
          onClick={() => setTtsOn(!ttsOn)}
        />
      </div>
    </Frame>
  );
};

export const States = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">states</h2>
    <div className="flex flex-wrap items-center gap-3">
      <IconButton icon="i-mdi:check" label="normal" />
      <IconButton icon="i-mdi:check" label="loading" loading />
      <IconButton icon="i-mdi:check" label="disabled" disabled />
      <IconButton icon="i-mdi:check" label="toggled" toggled />
    </div>
  </Frame>
);

export const DangerHover = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">
      danger variant (hover to see red)
    </h2>
    <div className="flex flex-wrap items-center gap-3">
      <IconButton variant="danger" icon="i-mdi:close"  label="关闭" />
      <IconButton variant="danger" icon="i-mdi:delete" label="删除" />
    </div>
  </Frame>
);

export const InTextareaSlot = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">
      simulated send button inside textarea (the real use case)
    </h2>
    <div className="relative max-w-lg rounded-lg border border-primary-200/15 bg-neutral-900/80 p-3">
      <textarea
        placeholder="输入消息…"
        rows={4}
        className="w-full resize-none bg-transparent text-neutral-100 outline-none pb-10 pr-10"
      />
      <div className="absolute bottom-3 right-3">
        <IconButton
          variant="primary"
          icon="i-mdi:send"
          label="发送 (Ctrl+Enter)"
          size="md"
        />
      </div>
    </div>
    <p className="mt-4 text-xs text-neutral-500">
      圆形发送按钮内嵌 textarea 右下角，符合 frontend-skeleton.md §5 规范。
    </p>
  </Frame>
);

export const DockPreview = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">
      floating dock preview (vertical column, glass panel)
    </h2>
    <div className="panel-glass inline-flex flex-col gap-2 rounded-lg p-2">
      <IconButton icon="i-mdi:chat-outline"     label="聊天" />
      <IconButton icon="i-mdi:cog-outline"      label="设置" />
      <IconButton icon="i-mdi:emoticon-outline" label="切换表情" />
      <IconButton icon="i-mdi:pin"              label="置顶" toggled />
      <IconButton icon="i-mdi:ghost-outline"    label="点击穿透" />
      <IconButton variant="danger" icon="i-mdi:close" label="退出" />
    </div>
  </Frame>
);
