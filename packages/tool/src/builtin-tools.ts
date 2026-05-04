import type { ToolDescriptor } from "./types.js"

/**
 * V1 内置工具描述。
 *
 * 这里只声明“工具是什么、参数是什么、风险是什么”，不在这里执行工具。
 * 真正执行会在 sandbox / tool executor 层完成。
 */
export const BUILTIN_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "read_file",
    displayName: "读取文件",
    description: "读取工作区内一个 UTF-8 文本文件的内容。",
    risk: "low",
    enabledByDefault: true,
    requiresSandbox: true,
    writesFiles: false,
    needsNetwork: false,
    parameters: objectSchema({
      path: stringSchema("工作区相对路径。"),
      maxBytes: numberSchema("最多读取的字节数，默认由系统限制。"),
    }, ["path"]),
  },
  {
    name: "list_dir",
    displayName: "列出目录",
    description: "列出工作区内某个目录的文件和子目录。",
    risk: "low",
    enabledByDefault: true,
    requiresSandbox: true,
    writesFiles: false,
    needsNetwork: false,
    parameters: objectSchema({
      path: stringSchema("工作区相对目录路径。"),
      recursive: booleanSchema("是否递归列出子目录。"),
    }, ["path"]),
  },
  {
    name: "search_text",
    displayName: "搜索文本",
    description: "在工作区内按文本或正则搜索文件内容。",
    risk: "low",
    enabledByDefault: true,
    requiresSandbox: true,
    writesFiles: false,
    needsNetwork: false,
    parameters: objectSchema({
      query: stringSchema("要搜索的文本或正则。"),
      path: stringSchema("限制搜索的工作区相对路径。"),
      regex: booleanSchema("是否按正则表达式解析 query。"),
    }, ["query"]),
  },
  {
    name: "write_file",
    displayName: "写入文件",
    description: "写入或覆盖工作区内的文本文件。高风险路径会被权限和沙箱拦截。",
    risk: "medium",
    enabledByDefault: true,
    requiresSandbox: true,
    writesFiles: true,
    needsNetwork: false,
    parameters: objectSchema({
      path: stringSchema("工作区相对路径。"),
      content: stringSchema("要写入的完整文本内容。"),
      expectedSha256: stringSchema("可选：写入前期望的旧内容哈希。"),
    }, ["path", "content"]),
  },
  {
    name: "run_command",
    displayName: "运行命令",
    description: "在工作区内运行一个非交互命令。默认不通过 shell，不允许越过工作区。",
    risk: "high",
    enabledByDefault: false,
    requiresSandbox: true,
    writesFiles: true,
    needsNetwork: false,
    parameters: objectSchema({
      command: stringSchema("可执行文件名，例如 pnpm。"),
      args: arraySchema("命令参数数组。"),
      cwd: stringSchema("工作区相对工作目录。"),
      timeoutMs: numberSchema("超时时间。"),
    }, ["command"]),
  },
  {
    name: "run_python",
    displayName: "运行 Python",
    description: "在工作区内运行一段 Python 脚本，脚本会写入临时文件后由 Python 解释器执行。",
    risk: "high",
    enabledByDefault: false,
    requiresSandbox: true,
    writesFiles: true,
    needsNetwork: false,
    parameters: objectSchema({
      code: stringSchema("要运行的 Python 代码。"),
      cwd: stringSchema("工作区相对工作目录。"),
      timeoutMs: numberSchema("超时时间。"),
      pythonCommand: stringSchema("Python 命令名，例如 python、python3 或 conda。"),
      pythonArgs: arraySchema("Python 命令的额外参数，例如 ['run','-n','Ema','python']。"),
    }, ["code"]),
  },
]

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  }
}

function stringSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    description,
  }
}

function numberSchema(description: string): Record<string, unknown> {
  return {
    type: "number",
    description,
  }
}

function booleanSchema(description: string): Record<string, unknown> {
  return {
    type: "boolean",
    description,
  }
}

function arraySchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: { type: "string" },
  }
}
