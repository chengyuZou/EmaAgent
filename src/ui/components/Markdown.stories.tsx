// 使用生产 Markdown 验收 ELK 分支、长文本、主题切换和未闭合流式代码块.
import { useEffect, useState } from 'react';
import { Button } from './Button.js';
import { Markdown } from './Markdown.js';
import '../styles/index.css';
import 'virtual:uno.css';

export default { title: 'Markdown / Mermaid' };

const flowchart = `flowchart TD
  A[LLM tool_use 意图] --> B[解析输入并校验上下文]
  B --> C{命中 deny 规则?}
  C -->|是| D[拒绝并返回原因]
  C -->|否| E{需要用户批准?}
  E -->|是| F[等待用户确认]
  E -->|否| G[执行工具]
  F --> G
  G --> H[返回结果]`;

const examples = `# 流程图
\`\`\`mermaid
${flowchart}
\`\`\`

## 时序图
\`\`\`mermaid
sequenceDiagram
  participant U as 用户
  participant A as Agent
  participant T as 工具
  U->>A: 提交请求
  A->>T: 执行工具
  T-->>A: 返回结果
  A-->>U: 交付
\`\`\`

## 长标签与分组
\`\`\`mermaid
flowchart LR
  subgraph Memory[长期记忆]
    M[查找用户工作与关系信息] --> N[检索并整理与当前请求相关的长期记忆]
  end
  N --> O[交给 Agent 消费]
\`\`\`

## 错误回退
\`\`\`mermaid
not a valid diagram
\`\`\``;

export const Diagrams = (): React.JSX.Element => {
  const [light, setLight] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
    };
  }, [light]);

  return (
    <main className="bg-[var(--ema-bg)] text-[var(--ema-text-primary)] p-6">
      <div className="flex gap-3 mb-4">
        <Button onClick={() => setLight(value => !value)}>切换明暗</Button>
        <Button onClick={() => setNarrow(value => !value)}>切换宽度</Button>
      </div>
      <div style={{ width: narrow ? 360 : 800, maxWidth: '100%' }}>
        <Markdown source={examples} />
      </div>
    </main>
  );
};

export const StreamingFence = (): React.JSX.Element => {
  const [closed, setClosed] = useState(false);
  return (
    <main className="bg-[var(--ema-bg)] text-[var(--ema-text-primary)] p-6">
      <Button onClick={() => setClosed(value => !value)}>切换围栏闭合</Button>
      <Markdown source={`\`\`\`mermaid\n${flowchart}${closed ? '\n```' : ''}`} streaming />
    </main>
  );
};
