import type { CSSProperties, JSX } from 'react';
import { MarkdownMedia } from '../../../lib/markdownMedia.js';
import { MORPH_NAME } from '../viewTransition.js';
import { SubagentPanel } from '../../../chat/sidePanel/tabs/subagents/SubagentPanel.js';
import { AttachmentDetail } from './attachmentDetail.js';
import { AudioDetail } from './audioDetail.js';
import { GoalDetail } from './goalDetail.js';
import { MessageDetail } from './messageDetail.js';
import { TokenDetail } from './tokenDetail.js';
import { TurnDetail } from './turnDetail.js';

export interface StorageDetailTarget {
  readonly kind: 'turns' | 'messages' | 'token' | 'goals' | 'attachments' | 'audio' | 'subagents';
  readonly sessionId: string;
  readonly sessionTitle: string;
}

const LABELS: { readonly [Kind in StorageDetailTarget['kind']]: string } = {
  turns: '轮次记录',
  messages: '原始消息',
  token: '用量明细',
  goals: '目标记录',
  attachments: '附件',
  audio: '音频',
  subagents: '子代理',
};

export function StorageDetail({ target, active, onClose }: {
  readonly target: StorageDetailTarget;
  readonly active: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  let content: JSX.Element;
  switch (target.kind) {
    case 'turns':
      content = <TurnDetail sessionId={target.sessionId} />;
      break;
    case 'messages':
      content = <MessageDetail sessionId={target.sessionId} />;
      break;
    case 'token':
      content = <TokenDetail sessionId={target.sessionId} />;
      break;
    case 'goals':
      content = <GoalDetail sessionId={target.sessionId} />;
      break;
    case 'attachments':
      content = <AttachmentDetail sessionId={target.sessionId} />;
      break;
    case 'audio':
      content = <AudioDetail sessionId={target.sessionId} active={active} />;
      break;
    case 'subagents':
      content = <SubagentPanel sessionId={target.sessionId} />;
      break;
  }
  const panel = target.kind === 'attachments' || target.kind === 'subagents';
  return (
    <div
      className="ema-material-workspace absolute inset-0 z-10 flex min-h-0 flex-col"
      style={{ viewTransitionName: MORPH_NAME } as CSSProperties}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--ema-border)] px-6 py-4">
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 text-sm text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)]"
          onClick={onClose}
        >
          <span className="i-lucide:arrow-left" aria-hidden />返回
        </button>
        <h2 className="truncate text-base font-semibold">{LABELS[target.kind]} · {target.sessionTitle}</h2>
      </header>
      <div className={panel ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'min-h-0 flex-1 overflow-y-auto p-6'}>
        <MarkdownMedia active={active}>
          {content}
        </MarkdownMedia>
      </div>
    </div>
  );
}
