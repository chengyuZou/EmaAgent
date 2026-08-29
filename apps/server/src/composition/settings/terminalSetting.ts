// 保存 Desktop 新建集成终端时采用的 Shell 可执行文件；空值表示由宿主自动选择。
import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';

export const terminalShellExecutableSetting = defineSetting<string>({
  key: 'frontend.terminal.shellExecutable',
  label: '集成终端 Shell',
  description: '选择以后新建的集成终端使用哪个本机 Shell；已经打开的终端不会改变。',
  apply: 'immediate',
  defaultValue: '',
  schema: z.string(),
});
