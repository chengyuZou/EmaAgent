// 提供 MCP 服务器配置、连接测试、导入和市场浏览界面。
import { useState } from 'react';
import { Button, IconButton, Input } from '@ema-agent/ui';
import { type McpKeyValuePair } from './mcp-form-state.js';

export function KeyValueEditor({
  pairs, onChange, keyPlaceholder, valuePlaceholder, secret,
}: {
  pairs:             McpKeyValuePair[];
  onChange:          (pairs: McpKeyValuePair[]) => void;
  keyPlaceholder?:   string;
  valuePlaceholder?: string;
  secret?:           boolean;
}): JSX.Element {
  const [reveal, setReveal] = useState(false);
  const update = (i: number, patch: Partial<McpKeyValuePair>): void =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            inputSize="sm" className="flex-1 font-mono" placeholder={keyPlaceholder}
            value={p.key} onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            inputSize="sm" className="flex-1 font-mono"
            type={secret && !reveal ? 'password' : 'text'} placeholder={valuePlaceholder}
            value={p.value} onChange={(e) => update(i, { value: e.target.value })}
          />
          <IconButton
            size="sm" label="删除" icon="i-mdi:close"
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
          <span className="i-mdi:plus text-base mr-0.5" aria-hidden /> 添加一项
        </Button>
        {secret && pairs.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setReveal((v) => !v)}>
            {reveal ? '隐藏值' : '显示值'}
          </Button>
        )}
      </div>
    </div>
  );
}