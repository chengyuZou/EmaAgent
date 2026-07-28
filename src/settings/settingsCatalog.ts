// 保存可公开给设置界面的业务定义目录，并拒绝重复设置键。

import { describeSetting } from './types.js';
import type {
  SettingDefinition,
  SettingDescriptor,
} from './types.js';

export class SettingsCatalog {
  private readonly definitions = new Map<string, SettingDefinition<unknown>>();

  constructor(definitions: readonly SettingDefinition<unknown>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<T>(definition: SettingDefinition<T>): void {
    if (this.definitions.has(definition.key)) {
      throw new Error(`Duplicate setting key: ${definition.key}`);
    }
    this.definitions.set(
      definition.key,
      definition as SettingDefinition<unknown>,
    );
  }

  list(): SettingDescriptor[] {
    return [...this.definitions.values()]
      .map(describeSetting)
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}
