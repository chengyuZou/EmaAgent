// 展示并目测验证基础原子组件在产品主题下的组合状态。

import { useState } from 'react';
import { Input }      from './Input.js';
import { Card }       from './Card.js';
import { Skeleton }   from './Skeleton.js';
import { Spinner }    from './Spinner.js';
import { Callout }    from './Callout.js';
import { Badge }      from './Badge.js';
import { Divider }    from './Divider.js';
import { Switch }     from './Switch.js';
import { Slider }     from './Slider.js';
import { Tabs }       from './Tabs.js';
import { ScrollArea } from './ScrollArea.js';

export default { title: 'Atoms / Simple' };

const Frame = ({ children, label }: { children: React.ReactNode; label: string }): React.JSX.Element => (
  <div className="bg-[var(--ema-bg)] p-8 text-[var(--ema-text-primary)]">
    <h2 className="mb-3 text-sm uppercase tracking-wider text-[var(--ema-text-secondary)]">{label}</h2>
    {children}
  </div>
);

export const InputDemo = (): React.JSX.Element => (
  <Frame label="Input">
    <div className="max-w-sm space-y-3">
      <Input placeholder="OpenAI API Key" />
      <Input placeholder="带 error" error defaultValue="bad value" />
      <Input placeholder="disabled" disabled />
    </div>
  </Frame>
);

export const CardDemo = (): React.JSX.Element => (
  <Frame label="Card variants">
    <div className="grid grid-cols-3 gap-4 max-w-3xl">
      <Card>default</Card>
      <Card variant="elevated">elevated</Card>
      <Card variant="glass">glass</Card>
    </div>
  </Frame>
);

export const SkeletonDemo = (): React.JSX.Element => (
  <Frame label="Skeleton (pulse vs wave)">
    <div className="max-w-md space-y-3">
      <Skeleton width="100%" height={20} animation="pulse" />
      <Skeleton width="80%"  height={20} animation="pulse" />
      <div className="h-3" />
      <Skeleton width="100%" height={20} animation="wave" />
      <Skeleton width="60%"  height={20} animation="wave" />
    </div>
  </Frame>
);

export const SpinnerDemo = (): React.JSX.Element => (
  <Frame label="Spinner sizes">
    <div className="flex items-center gap-4">
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </div>
  </Frame>
);

export const CalloutDemo = (): React.JSX.Element => (
  <Frame label="Callout variants">
    <div className="max-w-md space-y-3">
      <Callout variant="info"    title="信息">  这是一条提示信息。</Callout>
      <Callout variant="success" title="成功">  操作已完成。</Callout>
      <Callout variant="warn"    title="警告">  注意可能的副作用。</Callout>
      <Callout variant="danger"  title="危险">  此操作不可撤销。</Callout>
    </div>
  </Frame>
);

export const BadgeDemo = (): React.JSX.Element => (
  <Frame label="Badge">
    <div className="flex flex-wrap items-center gap-2">
      <Badge>neutral</Badge>
      <Badge variant="primary">primary</Badge>
      <Badge variant="violet">violet</Badge>
      <Badge variant="success">success</Badge>
      <Badge variant="warn">warn</Badge>
      <Badge variant="danger">danger</Badge>
      <Badge variant="success" dot>已连接</Badge>
      <Badge variant="danger"  dot />
    </div>
  </Frame>
);

export const DividerDemo = (): React.JSX.Element => (
  <Frame label="Divider">
    <div className="max-w-md">
      <p>上面</p>
      <Divider spaced />
      <p>中间</p>
      <Divider spaced />
      <p>下面</p>
      <div className="mt-6 flex h-12 items-center gap-2">
        <span>左</span><Divider orientation="vertical" /><span>中</span><Divider orientation="vertical" /><span>右</span>
      </div>
    </div>
  </Frame>
);

export const SwitchDemo = (): React.JSX.Element => {
  const [on, setOn] = useState(true);
  return (
    <Frame label="Switch">
      <div className="space-y-3">
        <Switch checked={on} onCheckedChange={setOn} showLabel label="始终置顶" />
        <Switch defaultChecked={false} showLabel label="点击穿透" />
        <Switch disabled showLabel label="禁用项" />
      </div>
    </Frame>
  );
};

export const SliderDemo = (): React.JSX.Element => {
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('medium');
  return (
    <Frame label="Slider (discrete steps for LLM Effort)">
      <div className="max-w-md">
        <Slider
          value={effort}
          onChange={setEffort}
          steps={[
            { value: 'low',    label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high',   label: 'High' },
            { value: 'max',    label: 'Max' },
          ]}
        />
        <p className="mt-4 text-xs text-[var(--ema-text-tertiary)]">当前: {effort}</p>
      </div>
    </Frame>
  );
};

export const TabsHorizontal = (): React.JSX.Element => {
  const [tab, setTab] = useState('chat');
  return (
    <Frame label="Tabs · underline (horizontal)">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'chat',      label: '聊天',  icon: 'i-mdi:chat-outline',     content: <p className="p-4">chat 模式内容</p> },
          { value: 'narrative', label: '叙事',  icon: 'i-mdi:book-open-outline', content: <p className="p-4">narrative 模式内容</p> },
          { value: 'agent',     label: 'Agent', icon: 'i-mdi:tools',            content: <p className="p-4">agent 模式内容</p> },
        ]}
      />
    </Frame>
  );
};

export const TabsSidebar = (): React.JSX.Element => {
  const [tab, setTab] = useState('providers');
  return (
    <Frame label="Tabs · sidebar (vertical, settings layout)">
      <div className="max-w-3xl">
        <Tabs
          value={tab}
          onChange={setTab}
          orientation="vertical"
          items={[
            { value: 'providers', label: '服务来源', icon: 'i-mdi:cloud-outline',   content: <Card>provider 配置内容</Card> },
            { value: 'bindings',  label: '模型绑定', icon: 'i-mdi:link-variant',    content: <Card>binding 配置内容</Card> },
            { value: 'cards',     label: '角色卡',   icon: 'i-mdi:card-account-details-outline', content: <Card>角色卡内容</Card> },
            { value: 'live2d',    label: 'Live2D',  icon: 'i-mdi:human',           content: <Card>Live2D 内容</Card> },
            { value: 'shortcuts', label: '快捷键',   icon: 'i-mdi:keyboard',        content: <Card>快捷键内容</Card> },
          ]}
        />
      </div>
    </Frame>
  );
};

export const ScrollAreaDemo = (): React.JSX.Element => (
  <Frame label="ScrollArea (custom scrollbar)">
    <ScrollArea className="h-48 max-w-md rounded-md border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <div className="p-4 space-y-2">
        {Array.from({ length: 30 }, (_, i) => (
          <div key={i} className="text-sm text-[var(--ema-text-secondary)]">行 {i + 1} —— 这是滚动区域里的一行内容</div>
        ))}
      </div>
    </ScrollArea>
  </Frame>
);
