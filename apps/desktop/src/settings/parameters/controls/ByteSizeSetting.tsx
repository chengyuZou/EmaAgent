// 把后端字节值以 MiB 展示和编辑.

import type { JSX } from 'react';
import type { SettingApply } from '../../../api/settings.js';
import { NumberSetting } from './NumberSetting.js';

const MIB = 1024 * 1024;

export function ByteSizeSetting(props: {
  title: string;
  hint: string;
  apply: SettingApply;
  value: number;
  onSave(value: number): Promise<void>;
  onReset(): Promise<void>;
}): JSX.Element {
  return (
    <NumberSetting
      title={props.title}
      hint={props.hint}
      apply={props.apply}
      value={props.value / MIB}
      unit="MiB"
      onSave={value => props.onSave(Math.round(value * MIB))}
      onReset={props.onReset}
    />
  );
}
