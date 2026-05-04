import { EmaError } from "@ema-agent/core-types"
import type { ToolSpec } from "@ema-agent/core-types"

import { BUILTIN_TOOL_DESCRIPTORS } from "./builtin-tools.js"
import { descriptorToToolSpec } from "./types.js"
import type { ToolDescriptor } from "./types.js"

export interface ToolRegistryOptions {
  tools?: readonly ToolDescriptor[]
}

/**
 * 工具注册表。
 *
 * 这里只维护工具元数据，不执行工具；这样模型 prompt、权限预览、设置页可以
 * 共用同一份 descriptor。
 */
export class ToolRegistry {
  private readonly descriptors = new Map<string, ToolDescriptor>()

  constructor(options: ToolRegistryOptions = {}) {
    for (const descriptor of options.tools ?? BUILTIN_TOOL_DESCRIPTORS) {
      this.register(descriptor)
    }
  }

  register(descriptor: ToolDescriptor): void {
    this.descriptors.set(descriptor.name, descriptor)
  }

  get(name: string): ToolDescriptor {
    const descriptor = this.descriptors.get(name)
    if (!descriptor) {
      throw new EmaError("tool_failed", `工具 ${name} 未注册。`, false)
    }
    return descriptor
  }

  list(): ToolDescriptor[] {
    return [...this.descriptors.values()]
  }

  listEnabledByDefault(): ToolDescriptor[] {
    return this.list().filter((descriptor) => descriptor.enabledByDefault)
  }

  toToolSpecs(names?: readonly string[]): ToolSpec[] {
    const descriptors = names
      ? names.map((name) => this.get(name))
      : this.listEnabledByDefault()

    return descriptors.map(descriptorToToolSpec)
  }
}
