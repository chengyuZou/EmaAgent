// 保存 Desktop 新建集成终端时采用的 Shell 可执行文件；空值表示由宿主自动选择。
import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';

export const terminalShellExecutableSetting = defineSetting({
  key: 'frontend.terminal.shellExecutable',
  apply: 'immediate',
  defaultValue: '',
  schema: z.string(),
});
