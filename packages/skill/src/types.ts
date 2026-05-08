/**
 * Skill 类型定义 — Skill 元数据、清单、解析结果。
 *
 * Skill 是可插拔的用户自定义能力扩展包。
 * 每个 skill 是一个目录，包含 skill.yaml 清单 + 可选的 prompts/scripts 文件。
 */

/** Skill 版本号（semver）。 */
export type SkillVersion = `${number}.${number}.${number}`

/** Skill 清单 — skill.yaml 的完整结构。 */
export interface SkillManifest {
  /** 技能名称（kebab-case，唯一标识）。 */
  name: string
  /** 展示名称。 */
  displayName: string
  /** 版本。 */
  version: SkillVersion
  /** 简短描述（一行）。 */
  description: string
  /** 详细使用说明（markdown）。 */
  instructions: string
  /** 作者信息。 */
  author?: {
    name: string
    email?: string
    url?: string
  }
  /** 许可证。 */
  license?: string
  /** 标签（用于分类/搜索）。 */
  tags?: string[]
  /** 依赖的 MCP server 名称列表。 */
  requiresMcpServers?: string[]
  /** 需要的权限列表。 */
  permissions?: SkillPermission[]
  /** 禁用的内置工具名称列表。 */
  disabledTools?: string[]
  /** skill 目录下的文件引用。 */
  prompts?: {
    /** 注入 system prompt 的文件路径（相对于 skill 目录）。 */
    system?: string
    /** 注入 user prompt 前缀的文件路径。 */
    userPrefix?: string
  }
  /** 工具脚本定义。 */
  tools?: SkillToolDefinition[]
}

/** Skill 需要的权限声明。 */
export interface SkillPermission {
  /** 权限类型。 */
  type: "network" | "filesystem" | "shell" | "python" | "env"
  /** 具体规则（如 "api.github.com"、"*.md"）。 */
  rule: string
  read: boolean
  write: boolean
}

/** Skill 定义的工具脚本。 */
export interface SkillToolDefinition {
  /** 工具名称（snake_case，skill 内部唯一）。 */
  name: string
  /** 工具描述（给 LLM 看的 function description）。 */
  description: string
  /** 参数 schema（JSON Schema 对象）。 */
  parameters: Record<string, unknown>
  /** 执行脚本路径（相对于 skill 目录）。 */
  script?: string
  /** 或直接内联 Python/Shell 代码。 */
  inline?: { language: "python" | "bash"; code: string }
  /** 执行超时（毫秒）。 */
  timeoutMs?: number
}

/** 已加载并可执行的 Skill 实例。 */
export interface LoadedSkill {
  manifest: SkillManifest
  /** Skill 目录在磁盘上的绝对路径。 */
  dirPath: string
  /** 解析后的 system prompt 文本（如果配置了 prompts.system）。 */
  systemPrompt?: string
  /** 解析后的 user prefix 文本（如果配置了 prompts.userPrefix）。 */
  userPrefix?: string
}
