import { defineSetting } from '@ema-agent/settings/definition';
import { z } from 'zod';

export const vishotCaptureEnabledSetting = defineSetting({
  key: 'vishotCapture.enabled',
  apply: 'immediate',
  defaultValue: false,
  schema: z.boolean(),
});

export const vishotCaptureIntervalSecondsSetting = defineSetting({
  key: 'vishotCapture.intervalSeconds',
  apply: 'immediate',
  defaultValue: 30,
  schema: z.number().int().min(10).max(86_400),
});
