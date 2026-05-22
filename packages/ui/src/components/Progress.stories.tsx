import { useState, useEffect } from 'react';
import { Progress } from './Progress.js';

// ── Progress stories ────────────────────────────────────────────────────────

export default { title: 'Atoms / Progress' };

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="min-h-screen bg-neutral-950 p-8 text-white max-w-md mx-auto space-y-6">{children}</div>
);

export const Determinate = (): React.JSX.Element => {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPct((p) => (p >= 100 ? 0 : p + 3)), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <Frame>
      <h2 className="text-sm uppercase tracking-wider text-neutral-400">determinate with shine</h2>
      <Progress progress={pct} />
      <p className="text-xs text-neutral-500">sinatra animation (AIRI-style progress-shine) while {'<'} 100%</p>
    </Frame>
  );
};

export const Complete = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">complete (no shine)</h2>
    <Progress progress={100} />
  </Frame>
);

export const IndeterminateHint = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">animated=false for indeterminate-like</h2>
    <Progress progress={70} animated={false} />
    <p className="text-xs text-neutral-500">
      使用 animated=false 时无 shine。真正的 indeterminate 模式走 <code>Spinner</code>。
    </p>
  </Frame>
);

export const CustomBarColor = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">danger bar colour</h2>
    <Progress progress={80} barClass="bg-red-400/80" />
  </Frame>
);

export const Zero = (): React.JSX.Element => (
  <Frame>
    <h2 className="text-sm uppercase tracking-wider text-neutral-400">0% (empty)</h2>
    <Progress progress={0} />
  </Frame>
);
