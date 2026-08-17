export class InvalidSettingValueError extends Error {
  readonly code = 'settings/invalid-value';

  constructor(readonly settingKey: string) {
    super(`设置值未通过业务校验: ${settingKey}`);
    this.name = 'InvalidSettingValueError';
  }
}

export class InvalidSettingGroupValueError extends Error {
  readonly code = 'settings/invalid-group-value';

  constructor(readonly groupId: string, detail?: string) {
    super(detail ?? `设置组未通过跨字段校验: ${groupId}`);
    this.name = 'InvalidSettingGroupValueError';
  }
}
