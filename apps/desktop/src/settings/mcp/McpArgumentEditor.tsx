// 提供 MCP stdio 参数的逐项编辑、排序与删除界面，始终保持 argv 数组语义。
import { Button, IconButton, Input } from '@ema-agent/ui';

export interface McpArgumentEditorProps {
  value: string[];
  onChange(value: string[]): void;
}

export function McpArgumentEditor({
  value,
  onChange,
}: McpArgumentEditorProps): JSX.Element {
  const updateArgument = (index: number, argument: string): void => {
    onChange(value.map((item, itemIndex) => (itemIndex === index ? argument : item)));
  };

  const removeArgument = (index: number): void => {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  };

  const moveArgument = (index: number, offset: -1 | 1): void => {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= value.length) return;
    const next = [...value];
    [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.map((argument, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <span
            className="w-6 shrink-0 text-right text-xs tabular-nums text-[var(--ema-text-tertiary)]"
            aria-hidden
          >
            {index + 1}
          </span>
          <Input
            inputSize="sm"
            className="min-w-0 flex-1 font-mono"
            aria-label={`参数 ${index + 1}`}
            placeholder={index === 0 ? '--config' : 'D:\\My Data\\config.json'}
            value={argument}
            onChange={(event) => updateArgument(index, event.target.value)}
          />
          <IconButton
            size="sm"
            label={`参数 ${index + 1} 上移`}
            icon="i-mdi:chevron-up"
            disabled={index === 0}
            onClick={() => moveArgument(index, -1)}
          />
          <IconButton
            size="sm"
            label={`参数 ${index + 1} 下移`}
            icon="i-mdi:chevron-down"
            disabled={index === value.length - 1}
            onClick={() => moveArgument(index, 1)}
          />
          <IconButton
            size="sm"
            label={`删除参数 ${index + 1}`}
            icon="i-mdi:close"
            onClick={() => removeArgument(index)}
          />
        </div>
      ))}

      <div className="flex items-center justify-between gap-2 pl-7">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...value, ''])}
        >
          <span className="i-mdi:plus text-base mr-0.5" aria-hidden />
          添加参数
        </Button>
        {value.some((argument) => argument.length === 0) && (
          <span className="text-[11px] text-[var(--ema-text-tertiary)]">
            空白项会作为空字符串参数保存
          </span>
        )}
      </div>
    </div>
  );
}
