// 展示并目测验证 Button 的变体、尺寸、形状和状态矩阵。
import { Button } from './Button.js';
import type { ButtonVariant, ButtonSize, ButtonShape } from './Button.js';

// ── Button stories ──────────────────────────────────────────────────────────

export default {
  title: 'Atoms / Button',
};

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
const SIZES:    ButtonSize[]    = ['sm', 'md', 'lg'];
const SHAPES:   ButtonShape[]   = ['rounded', 'pill'];

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-[var(--ema-bg)] p-8 text-[var(--ema-text-primary)]">{children}</div>
);

export const Variants = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">variants</h2>
    <div className="flex flex-wrap gap-3">
      {VARIANTS.map((v) => (
        <Button key={v} variant={v}>{v}</Button>
      ))}
    </div>
  </Frame>
);

export const Sizes = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">sizes</h2>
    <div className="flex flex-wrap items-center gap-3">
      {SIZES.map((s) => (
        <Button key={s} variant="primary" size={s}>{s} button</Button>
      ))}
    </div>
  </Frame>
);

export const Shapes = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">shapes</h2>
    <div className="flex flex-wrap gap-3">
      {SHAPES.map((s) => (
        <Button key={s} variant="secondary" shape={s}>{s}</Button>
      ))}
    </div>
  </Frame>
);

export const WithIcon = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">with icon</h2>
    <div className="flex flex-wrap gap-3">
      <Button variant="primary"   icon="i-mdi:send">    发送</Button>
      <Button variant="secondary" icon="i-mdi:cog">    设置</Button>
      <Button variant="danger"    icon="i-mdi:delete"> 删除</Button>
      <Button variant="ghost"     icon="i-mdi:close">  关闭</Button>
    </div>
  </Frame>
);

export const States = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">states</h2>
    <div className="flex flex-wrap gap-3">
      <Button variant="primary">normal</Button>
      <Button variant="primary" loading>loading</Button>
      <Button variant="primary" disabled>disabled</Button>
    </div>
  </Frame>
);

export const Block = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">block (full width)</h2>
    <div className="max-w-sm space-y-3">
      <Button variant="primary"   block>主要操作</Button>
      <Button variant="secondary" block>次要操作</Button>
    </div>
  </Frame>
);

export const Matrix = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-4 text-sm uppercase tracking-wider text-neutral-400">full matrix</h2>
    <table className="border-collapse">
      <thead>
        <tr className="text-xs text-neutral-500">
          <th className="px-3 pb-2 text-left">variant ↓ / size →</th>
          {SIZES.map((s) => <th key={s} className="px-3 pb-2 text-left">{s}</th>)}
        </tr>
      </thead>
      <tbody>
        {VARIANTS.map((v) => (
          <tr key={v}>
            <td className="px-3 py-2 text-xs text-neutral-400">{v}</td>
            {SIZES.map((s) => (
              <td key={s} className="px-3 py-2">
                <Button variant={v} size={s}>label</Button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </Frame>
);
