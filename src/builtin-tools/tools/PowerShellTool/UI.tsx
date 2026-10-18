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
