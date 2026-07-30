// 描述后台 Shell 的可信身份与状态，避免前端从模型文本猜测进程信息。

import type { BackgroundProcessId } from '@ema-agent/ids';
import type { BackgroundProcessStatus } from '../background/types.js';

export interface BackgroundProcessPresentation {
  readonly kind: 'background_process';
  readonly backgroundProcessId: BackgroundProcessId;
  readonly command: string;
  readonly workingDirectory: string;
  readonly status: BackgroundProcessStatus;
}

export function createBackgroundProcessPresentation(
  input: Omit<BackgroundProcessPresentation, 'kind'>,
): BackgroundProcessPresentation {
  return { ...input, kind: 'background_process' };
}
