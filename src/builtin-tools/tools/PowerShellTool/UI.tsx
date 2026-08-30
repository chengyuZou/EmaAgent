// PowerShellTool 的桌面展示：与 Bash 共用终端卡（同为 commandResult 输出），
// 本文件只提供入口转发；没有 Bash 的后台转交分支（本工具不产生 processReference）。
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
