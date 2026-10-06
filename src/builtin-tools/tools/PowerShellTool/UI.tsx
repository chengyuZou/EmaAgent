// 两种 Shell 共用命令结果、实时输出和后台进程引用的终端展示.
import type { JSX } from 'react';
import {
  BashCallView,
  bashCopyText,
  bashTitle,
  type BashCallViewProps,
} from '../BashTool/UI.js';

export type PowerShellCallViewProps = BashCallViewProps;

export function PowerShellCallView(props: PowerShellCallViewProps): JSX.Element {
  return <BashCallView {...props} />;
}

export const powerShellTitle = bashTitle;
export const powerShellCopyText = bashCopyText;
