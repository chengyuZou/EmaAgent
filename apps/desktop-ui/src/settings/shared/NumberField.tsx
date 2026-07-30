// 设置项的数字输入:本地文本态,失焦或回车才按范围收敛并提交,不打断输入过程。
import { useEffect, useState, type JSX } from 'react';
import { Input } from '@ema-agent/ui';

export interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  /** 显示单位,如 MB、秒;仅后缀展示,不进提交值。 */
  unit?: string;
  onCommit(next: number): void;
}

export function NumberField({ value, min, max, unit, onCommit }: NumberFieldProps): JSX.Element {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(String(value));
    setInvalid(false);
  }, [value]);

  const commit = (): void => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setInvalid(true);
      setText(String(value));
      return;
    }
    setInvalid(false);
    onCommit(Math.min(max, Math.max(min, Math.round(parsed))));
  };

  return (
    <span className="flex items-center gap-1.5">
      <Input
        type="number"
        inputSize="sm"
        className="w-24"
        min={min}
        max={max}
        value={text}
        error={invalid}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="shrink-0 text-[11px] text-[var(--ema-text-tertiary)]">{unit}</span>}
    </span>
  );
}
