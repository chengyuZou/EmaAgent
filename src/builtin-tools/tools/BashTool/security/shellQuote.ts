import { type ParseEntry, parse as shellQuoteParse } from 'shell-quote'

export type { ParseEntry } from 'shell-quote'

export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }

export function tryParseShellCommand(
  cmd: string,
  env?:
    | Record<string, string | undefined>
    | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const tokens =
      typeof env === 'function'
        ? shellQuoteParse(cmd, env)
        : shellQuoteParse(cmd, env)
    return { success: true, tokens }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parse error',
    }
  }
}

/**
 * 检查解析出的 token 是否含畸形条目,暗示 shell-quote 误解了命令.
 * 当输入含歧义模式(如 JSON 风格且带分号的字符串)时会发生,shell-quote
 * 按 shell 规则解析,产生 token 碎片.
 *
 * 例如 `echo {"hi":"hi;evil"}` 被解析时 `;` 是运算符,产生
 * `{hi:"hi`(花括号不配平)这类 token.合法命令产生完整, 配平的 token.
 *
 * 同时检测原命令中未闭合的引号:shell-quote 会静默丢弃不匹配的 `"` 或
 * `'` 并把剩余部分当不带引号解析,token 里不留痕迹.`echo "hi;evil | cat`
 * (一个未匹配 `"`)在 bash 是语法错误,但 shell-quote 产生干净的 token
 * 且 `;` 是运算符.下面的 token 级检查抓不到,所以用 bash 引号语义遍历
 * 原命令并标记奇数奇偶性.
 *
 * 安全:这防止 HackerOne #3482049 中 shell-quote 对歧义输入的正确解析
 * 被利用导致的命令注入.
 */
export function hasMalformedTokens(
  command: string,
  parsed: ParseEntry[],
): boolean {
  // 检查原命令中未闭合的引号.shell-quote 丢弃不匹配引号而不留痕迹,
  // 所以必须检查原始字符串.按 bash 语义遍历:单引号外反斜杠转义下一
  // 字符;单引号内无转义.
  let inSingle = false
  let inDouble = false
  let doubleCount = 0
  let singleCount = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\' && !inSingle) {
      i++
      continue
    }
    if (c === '"' && !inSingle) {
      doubleCount++
      inDouble = !inDouble
    } else if (c === "'" && !inDouble) {
      singleCount++
      inSingle = !inSingle
    }
  }
  if (doubleCount % 2 !== 0 || singleCount % 2 !== 0) return true

  for (const entry of parsed) {
    if (typeof entry !== 'string') continue

    // 检查花括号是否配平
    const openBraces = (entry.match(/{/g) || []).length
    const closeBraces = (entry.match(/}/g) || []).length
    if (openBraces !== closeBraces) return true

    // 检查圆括号是否配平
    const openParens = (entry.match(/\(/g) || []).length
    const closeParens = (entry.match(/\)/g) || []).length
    if (openParens !== closeParens) return true

    // 检查方括号是否配平
    const openBrackets = (entry.match(/\[/g) || []).length
    const closeBrackets = (entry.match(/\]/g) || []).length
    if (openBrackets !== closeBrackets) return true

    // 检查双引号是否配平
    // 统计未被转义(前面无反斜杠)的引号
    // 未转义引号为奇数个的 token 是畸形的
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 由调用方的 hasCommandSeparator 检查门控,运行在短 per-token 字符串上
    const doubleQuotes = entry.match(/(?<!\\)"/g) || []
    if (doubleQuotes.length % 2 !== 0) return true

    // 检查单引号是否配平
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 同上
    const singleQuotes = entry.match(/(?<!\\)'/g) || []
    if (singleQuotes.length % 2 !== 0) return true
  }
  return false
}

/**
 * 检测含 '\' 模式, 利用 shell-quote 库对单引号内反斜杠处理错误的命令.
 *
 * bash 中单引号保留所有字符的字面量 - 反斜杠没有特殊含义.所以 '\' 就是
 * 字符串 \(引号打开,含 \, 下一个 ' 关闭它).但 shell-quote 错误地把
 * \ 当作单引号内的转义字符,导致 '\' 不会关闭带引号字符串.
 *
 * 这意味着模式 '\' <payload> '\' 会把 <payload> 从安全检查中藏起来,
 * 因为 shell-quote 认为整个都在一个单引号字符串内.
 */
export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  // 用正确的 bash 单引号语义遍历命令
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // 处理单引号外的反斜杠转义
    if (char === '\\' && !inSingleQuote) {
      // 跳过下一字符(它被转义了)
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote

      // 检查是否刚关闭单引号且内容以尾随反斜杠结尾.shell-quote 的
      // 分块正则 '((\\'|[^'])*?)' 错误地把 \' 当作单引号内的转义序列,
      // 而 bash 把反斜杠当字面量.这产生解析差异:shell-quote 合并
      // bash 视为独立的 token.
      //
      // 奇数个尾随 \ 总是 bug:
      //   '\' -> shell-quote: \' = 字面 ',仍在开引号.bash: \, 已闭合.
      //   'abc\' -> shell-quote: abc 然后 \' = 字面 ',仍在开引号.bash: abc\, 已闭合.
      //   '\\\'  -> shell-quote: \\ + \',仍在开引号.bash: \\\, 已闭合.
      //
      // 偶数个尾随 \ 仅当命令中存在后续 ' 时才是 bug:
      //   '\\' 单独 -> shell-quote 回溯,两个解析器都同意字符串闭合.OK.
      //   '\\' 'next' -> shell-quote: \' 消费闭引号,把下一个 ' 当作
      //                   假闭合,合并 token.bash: 两个独立 token.
      //
      //   细节:正则分支在 [^'] 之前尝试 \'.对 '\\',先通过 [^'] 匹配
      //   第一个 \(下一字符是 \ 不是 '),再通过 \' 匹配第二个 \(下一
      //   字符确实是 ').这会消费闭引号.正则继续读取直到找到另一个 '
      //   闭合匹配.若不存在则回溯到 [^'] 处理第二个 \ 并正确闭合.若存在
      //   后续 '(例如下一个单引号参数的开启符),不回溯且 token 合并.
      //   见 H1 报告:git ls-remote 'safe\\' '--upload-pack=evil' 'repo'
      //   shell-quote: ["git","ls-remote","safe\\\\ --upload-pack=evil repo"]
      //   bash:        ["git","ls-remote","safe\\\\","--upload-pack=evil","repo"]
      if (!inSingleQuote) {
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && command[j] === '\\') {
          backslashCount++
          j--
        }
        if (backslashCount > 0 && backslashCount % 2 === 1) {
          return true
        }
        // 偶数个尾随反斜杠:仅当存在后续 ' 供分块正则作为假闭合引号用时
        // 才是 bug.检查任何后续 ',因为正则不尊重 bash 引号状态
        // (例如双引号内的 ' 同样可被消费).
        if (
          backslashCount > 0 &&
          backslashCount % 2 === 0 &&
          command.indexOf("'", i + 1) !== -1
        ) {
          return true
        }
      }
      continue
    }
  }

  return false
}
