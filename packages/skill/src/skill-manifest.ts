/**
 * SkillManifest 解析器 — 读取并校验 skill.yaml。
 *
 * 对 skill.yaml 做结构校验，补全默认值，返回类型安全的 SkillManifest。
 */

import type { SkillManifest, SkillVersion } from "./types.js"

const SKILL_VERSION_RE = /^\d+\.\d+\.\d+$/

/** 校验 skill.yaml 的结构，补全默认字段。 */
export function parseSkillManifest(raw: unknown, sourcePath: string): SkillManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Skill manifest must be an object: ${sourcePath}`)
  }

  const m = raw as Record<string, unknown>

  // 必填字段
  const name = validateString(m.name, "name", sourcePath)
  validateKebabCase(name, sourcePath)

  const displayName = validateString(m.displayName, "displayName", sourcePath)
  const version = validateVersion(m.version, sourcePath)
  const description = validateString(m.description, "description", sourcePath)
  const instructions = validateString(m.instructions, "instructions", sourcePath)

  // 可选字段
  const author = m.author && typeof m.author === "object"
    ? {
        name: validateString((m.author as Record<string, unknown>).name, "author.name", sourcePath),
        email: (m.author as Record<string, unknown>).email as string | undefined,
        url: (m.author as Record<string, unknown>).url as string | undefined,
      }
    : undefined

  return {
    name,
    displayName,
    version,
    description,
    instructions,
    author,
    license: m.license as string | undefined,
    tags: asStringArray(m.tags, "tags", sourcePath),
    requiresMcpServers: asStringArray(m.requiresMcpServers, "requiresMcpServers", sourcePath),
    permissions: asPermissionsArray(m.permissions, sourcePath),
    disabledTools: asStringArray(m.disabledTools, "disabledTools", sourcePath),
    prompts: m.prompts as SkillManifest["prompts"] | undefined,
    tools: asToolsArray(m.tools, sourcePath),
  }
}

function validateString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Skill "${field}" must be a non-empty string: ${sourcePath}`)
  }
  return value.trim()
}

function validateKebabCase(value: string, sourcePath: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`Skill name must be kebab-case: "${value}" in ${sourcePath}`)
  }
}

function validateVersion(value: unknown, sourcePath: string): SkillVersion {
  const v = validateString(value, "version", sourcePath)
  if (!SKILL_VERSION_RE.test(v)) {
    throw new Error(`Skill version must be semver (x.y.z): "${v}" in ${sourcePath}`)
  }
  return v as SkillVersion
}

function asStringArray(value: unknown, field: string, sourcePath: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`Skill "${field}" must be an array of strings: ${sourcePath}`)
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`Skill "${field}" items must be strings: ${sourcePath}`)
    }
  }
  return value as string[]
}

function asPermissionsArray(value: unknown, sourcePath: string) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`Skill "permissions" must be an array: ${sourcePath}`)
  }
  return (value as Array<Record<string, unknown>>).map((p, i) => ({
    type: validateString(p.type, `permissions[${i}].type`, sourcePath) as "network" | "filesystem" | "shell" | "python" | "env",
    rule: validateString(p.rule, `permissions[${i}].rule`, sourcePath),
    read: Boolean(p.read),
    write: Boolean(p.write),
  }))
}

function asToolsArray(value: unknown, sourcePath: string) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`Skill "tools" must be an array: ${sourcePath}`)
  }
  return (value as Array<Record<string, unknown>>).map((t, i) => ({
    name: validateString(t.name, `tools[${i}].name`, sourcePath),
    description: validateString(t.description, `tools[${i}].description`, sourcePath),
    parameters: (t.parameters as Record<string, unknown>) ?? {},
    script: t.script as string | undefined,
    inline: t.inline as { language: "python" | "bash"; code: string } | undefined,
    timeoutMs: typeof t.timeoutMs === "number" ? t.timeoutMs : undefined,
  }))
}
