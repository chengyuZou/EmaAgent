// 把后端 0 到 1 的比例以百分数展示和编辑.

import type { JSX } from 'react';
import type { SettingApply } from '../../../api/settings.js';
import { NumberSetting } from './NumberSetting.js';

export function PercentSetting(props: {
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
      value={props.value * 100}
      unit="%"
      onSave={value => props.onSave(value / 100)}
      onReset={props.onReset}
    />
  );
}
