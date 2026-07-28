export class InvalidSettingValueError extends Error {
  readonly code = 'settings/invalid-value';

  constructor(readonly settingKey: string) {
    super(`设置值未通过业务校验: ${settingKey}`);
    this.name = 'InvalidSettingValueError';
  }
}
