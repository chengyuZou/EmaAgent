/**
 * SkillLoader — 从文件系统加载 skill 目录。
 *
 * 扫描 skill 目录，解析 skill.yaml，加载 prompts/scripts 文件。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseSkillManifest } from "./skill-manifest.js"
import type { LoadedSkill } from "./types.js"

/** 从 skill 目录加载单个 skill。 */
export function loadSkill(dirPath: string): LoadedSkill {
  const manifestPath = join(dirPath, "skill.yaml")
  if (!existsSync(manifestPath)) {
    throw new Error(`skill.yaml not found in: ${dirPath}`)
  }

  const yamlRaw = readFileSync(manifestPath, "utf-8")
  // 运行时使用 yaml 库解析，这里定义解析接口
  const parsed = parseYaml(yamlRaw)
  const manifest = parseSkillManifest(parsed, manifestPath)

  const loaded: LoadedSkill = { manifest, dirPath }

  if (manifest.prompts?.system) {
    const systemPath = join(dirPath, manifest.prompts.system)
    if (existsSync(systemPath)) {
      loaded.systemPrompt = readFileSync(systemPath, "utf-8")
    }
  }

  if (manifest.prompts?.userPrefix) {
    const prefixPath = join(dirPath, manifest.prompts.userPrefix)
    if (existsSync(prefixPath)) {
      loaded.userPrefix = readFileSync(prefixPath, "utf-8")
    }
  }

  return loaded
}

/** 扫描目录，加载所有 skill。 */
export function loadSkillsFromDir(rootDir: string): LoadedSkill[] {
  if (!existsSync(rootDir)) return []

  const skills: LoadedSkill[] = []
  const entries = readdirSync(rootDir)

  for (const entry of entries) {
    const fullPath = join(rootDir, entry)
    try {
      if (statSync(fullPath).isDirectory()) {
        const manifestPath = join(fullPath, "skill.yaml")
        if (existsSync(manifestPath)) {
          skills.push(loadSkill(fullPath))
        }
      }
    } catch {
      // 跳过无法加载的目录
    }
  }

  return skills
}

/**
 * 简易 YAML 解析器。
 *
 * V1 仅支持扁平 key: value 和简单嵌套（2 层），
 * 升级路径：接入 `yaml` npm 包做完整 YAML 1.2 解析。
 */
function parseYaml(raw: string): unknown {
  // 简陋但无外部依赖的 YAML 解析——仅支持 skill.yaml 的基本结构
  // 生产环境应替换为 `yaml` 或 `js-yaml` 库
  const lines = raw.split("\n")
  const root: Record<string, unknown> = {}
  let currentSection: string | null = null
  let currentSectionObj: Record<string, unknown> | null = null
  let currentList: Array<unknown> | null = null
  let currentListItem: Record<string, unknown> | null = null

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue

    const indent = line.search(/\S/)
    const trimmed = line.trim()

    if (indent === 0) {
      // 顶层 key: value
      currentSection = null
      currentSectionObj = null
      currentList = null
      currentListItem = null

      const colonIdx = trimmed.indexOf(":")
      if (colonIdx === -1) continue
      const key = trimmed.slice(0, colonIdx).trim()
      const value = trimmed.slice(colonIdx + 1).trim()
      if (value === "" || value === "|") {
        // 多行字符串标记
        root[key] = ""
      } else {
        root[key] = parseYamlValue(value)
      }
      currentSection = key
    } else if (indent === 2) {
      if (trimmed.startsWith("- ")) {
        // 列表项
        const itemValue = trimmed.slice(2).trim()
        const colonIdx = itemValue.indexOf(":")
        if (colonIdx !== -1) {
          currentListItem = { [itemValue.slice(0, colonIdx).trim()]: parseYamlValue(itemValue.slice(colonIdx + 1).trim()) }
          if (!currentList) {
            currentList = []
            if (currentSection) root[currentSection] = currentList
          }
          currentList.push(currentListItem)
        } else {
          if (!currentList) {
            currentList = []
            if (currentSection) root[currentSection] = currentList
          }
          currentList.push(parseYamlValue(itemValue))
        }
      } else {
        // 嵌套属性
        const colonIdx = trimmed.indexOf(":")
        if (colonIdx === -1) continue
        const key = trimmed.slice(0, colonIdx).trim()
        const value = trimmed.slice(colonIdx + 1).trim()
        if (currentListItem) {
          currentListItem[key] = parseYamlValue(value)
        } else {
          if (!currentSectionObj) {
            currentSectionObj = {}
            if (currentSection) root[currentSection] = currentSectionObj
          }
          currentSectionObj[key] = parseYamlValue(value)
        }
      }
    } else if (indent === 4) {
      if (trimmed.startsWith("- ")) {
        const itemValue = trimmed.slice(2).trim()
        const colonIdx = itemValue.indexOf(":")
        if (colonIdx !== -1 && currentListItem) {
          const nestedKey = itemValue.slice(0, colonIdx).trim()
          currentListItem[nestedKey] = parseYamlValue(itemValue.slice(colonIdx + 1).trim())
        }
      } else {
        const colonIdx = trimmed.indexOf(":")
        if (colonIdx !== -1 && currentListItem) {
          const key = trimmed.slice(0, colonIdx).trim()
          currentListItem[key] = parseYamlValue(trimmed.slice(colonIdx + 1).trim())
        }
      }
    }
  }

  return root
}

function parseYamlValue(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  if (value === "~" || value === "null") return null
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)
  // unquote
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}
