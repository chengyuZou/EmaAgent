// 浏览器验收夹具: 真实面板、CSS 和虚拟列表; 固定数据不写用户数据库或调用模型.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SubagentMessage } from '@ema-agent/agent';
import { subagentsApi, type SubagentRecord } from '../src/api/subagents.js';
import { SubagentPanel } from '../src/chat/sidePanel/tabs/subagents/SubagentPanel.js';
import { useSubagentStore } from '../src/stores/subagent.js';
import '../src/styles/index.css';
import 'virtual:uno.css';

const child: SubagentRecord = {
  id: 'test-child',
  sessionId: 'test-session',
  title: '模块检查',
  description: '检查边界后继续验证, 两次执行共用同一子代理',
  permissionMode: 'default',
  providerId: 'p',
  modelId: 'm',
  protocol: 'openai-llm',
  reasoningEffort: 'high',
  status: 'completed',
  createdAt: 1,
  updatedAt: 200,
};

const messages: SubagentMessage[] = Array.from({ length: 150 }, (_, index) => {
  const assistant = index % 2 === 1;
  let runId: string | null = 'second';
  if (index < 8) {
    runId = null;
  } else if (index < 80) {
    runId = 'first';
  }
  return {
    id: 'message-' + index.toString().padStart(3, '0'),
    subagentId: child.id,
    runId,
    role: assistant ? 'assistant' : 'user',
    kind: 'normal',
    blocks: assistant
      ? [
        {
          type: 'thinking',
          thinking: '检查模块边界与持久关系.',
          signature: '',
        },
        {
          type: 'text',
          text: `### 消息 ${index}\n\n${'这是该条消息的正文, 可以展开思考后检查动态行高. '.repeat(index % 5 + 1)}`,
        },
      ]
      : `任务 ${index}: 阅读模块后汇报, 不修改文件.`,
    createdAt: index + 1,
    summarizedThroughMessageId: null,
  };
});

function windowPage(items: readonly SubagentMessage[]) {
  const first = items[0];
  const last = items.at(-1);
  return {
    items,
    olderCursor: first && first.createdAt > 1
      ? {
        id: first.id,
        createdAt: first.createdAt,
      }
      : null,
    newerCursor: last && last.createdAt < messages.length
      ? {
        id: last.id,
        createdAt: last.createdAt,
      }
      : null,
  };
}

subagentsApi.list = async () => ({
  items: [child],
  nextCursor: null,
});
subagentsApi.get = async () => child;
subagentsApi.listMessages = async (_id, cursor, direction) => {
  if (!cursor) {
    return windowPage(messages.slice(-50));
  }
  if (direction === 'after') {
    return windowPage(messages
      .filter(message => message.createdAt > cursor.createdAt)
      .slice(0, 50));
  }
  return windowPage(messages
    .filter(message => message.createdAt < cursor.createdAt)
    .slice(-50));
};

function Fixture() {
  const [width, setWidth] = useState(620);
  const [theme, setTheme] = useState('dark');
  return (
    <div>
      <div
        className="flex items-center justify-center gap-4 py-2 text-xs text-[var(--ema-text-primary)]"
      >
        <label>
          面板宽度
          <input
            aria-label="面板宽度"
            type="number"
            min={320}
            max={1100}
            value={width}
            onChange={event => setWidth(Number(event.target.value))}
            className="ml-2 w-20 rounded border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-2 py-1"
          />
        </label>
        <button
          onClick={() => {
            const next = theme === 'dark' ? 'light' : 'dark';
            setTheme(next);
            document.documentElement.dataset.theme = next;
          }}
        >
          切换主题
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          width,
          maxWidth: '100%',
          height: '85vh',
          margin: '0 auto',
          background: 'var(--ema-surface-1)',
          border: '1px solid var(--ema-border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <SubagentPanel sessionId={child.sessionId} />
      </div>
    </div>
  );
}

document.documentElement.dataset.theme = 'dark';
document.body.style.background = 'var(--ema-surface-0)';
useSubagentStore.getState().rememberSubagents([child]);
createRoot(document.getElementById('root')!).render(<Fixture />);
