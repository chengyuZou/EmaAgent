// Aggregated stories for Dialog / Popover / Tooltip / DropdownMenu / Select —
// Radix overlays all rendered into portals. One stories file keeps the Ladle
// sidebar cleaner since each only needs 1-2 examples.

import { useState } from 'react';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';
import { Dialog } from './Dialog.js';
import { Popover } from './Popover.js';
import { Tooltip, TooltipProvider } from './Tooltip.js';
import { DropdownMenu } from './DropdownMenu.js';
import { Select } from './Select.js';

export default { title: 'Atoms / Overlays' };

const Frame = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <TooltipProvider delayDuration={200}>
    <div className="min-h-screen bg-neutral-950 p-8 text-white">{children}</div>
  </TooltipProvider>
);

export const DialogExample = (): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <Frame>
      <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">dialog</h2>
      <Button variant="primary" onClick={() => setOpen(true)}>打开 dialog</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="确认删除？"
        description="此操作不可撤销，确定要继续吗？"
      >
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost"  onClick={() => setOpen(false)}>取消</Button>
          <Button variant="danger" onClick={() => setOpen(false)}>删除</Button>
        </div>
      </Dialog>
    </Frame>
  );
};

export const PopoverExample = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">popover</h2>
    <Popover
      widthClass="w-64"
      trigger={<Button variant="secondary" icon="i-mdi:chevron-down">点开 popover</Button>}
    >
      <div className="p-2">
        <p className="text-sm">这是一个 popover 面板。可以放任何内容。</p>
        <ul className="mt-2 text-xs text-neutral-400 space-y-0.5">
          <li>• 鼠标点外部自动关</li>
          <li>• Esc 也能关</li>
          <li>• Radix 处理 focus trap</li>
        </ul>
      </div>
    </Popover>
  </Frame>
);

export const TooltipExample = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">tooltip</h2>
    <div className="flex gap-3">
      <Tooltip content="hover 看 tooltip">
        <IconButton icon="i-mdi:information" label="info" />
      </Tooltip>
      <Tooltip content="发送 (Ctrl+Enter)" side="right">
        <IconButton variant="primary" icon="i-mdi:send" label="send" />
      </Tooltip>
    </div>
  </Frame>
);

export const DropdownMenuExample = (): React.JSX.Element => (
  <Frame>
    <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">dropdown menu</h2>
    <DropdownMenu
      trigger={<Button variant="secondary" icon="i-mdi:dots-vertical">操作</Button>}
      items={[
        { kind: 'item',     label: '复制',  icon: 'i-mdi:content-copy', shortcut: 'Ctrl+C', onSelect: () => alert('复制') },
        { kind: 'item',     label: '编辑',  icon: 'i-mdi:pencil',       onSelect: () => alert('编辑') },
        { kind: 'separator' },
        { kind: 'submenu',  label: '模式',  icon: 'i-mdi:robot', items: [
          { kind: 'item', label: '聊天',  onSelect: () => alert('chat') },
          { kind: 'item', label: '叙事',  onSelect: () => alert('narrative') },
          { kind: 'submenu', label: 'Agent', items: [
            { kind: 'item', label: 'Plan',  onSelect: () => alert('plan') },
            { kind: 'item', label: 'Debug', onSelect: () => alert('debug') },
            { kind: 'item', label: 'Full',  onSelect: () => alert('full') },
          ]},
        ]},
        { kind: 'separator' },
        { kind: 'item',     label: '删除',  icon: 'i-mdi:delete', danger: true, onSelect: () => alert('删除') },
      ]}
    />
  </Frame>
);

export const SelectExample = (): React.JSX.Element => {
  const [value, setValue] = useState('deepseek-v4-flash');
  return (
    <Frame>
      <h2 className="mb-3 text-sm uppercase tracking-wider text-neutral-400">select</h2>
      <div className="max-w-xs">
        <Select
          value={value}
          onChange={setValue}
          options={[
            { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', icon: 'i-mdi:lightning-bolt' },
            { value: 'deepseek-v3',       label: 'DeepSeek V3' },
            { value: 'qwen-72b',          label: 'Qwen 72B' },
            { value: 'gpt-4o',            label: 'GPT-4o' },
          ]}
        />
        <p className="mt-2 text-xs text-neutral-500">当前: {value}</p>
      </div>
    </Frame>
  );
};
