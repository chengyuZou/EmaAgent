// FileEditTool 的文本匹配引擎: 引号归一定位、引号风格保持、出现次数统计、尾空白裁剪。

/** 把排版引号归一化为直 ASCII 等价物以便匹配。 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛′‵]/g, "'") // 单弯引号 -> '
    .replace(/[“”„‟″‶]/g, '"'); // 双弯引号 -> "
}

/**
 * 在 `fileContent` 中定位 `search`,先精确匹配,再引号归一化兜底。
 * 返回文件中的实际子串,以便替换用文件自己的引号风格。
 */
export function findActualString(fileContent: string, search: string): string | null {
  if (fileContent.includes(search)) return search;

  // 精确匹配失败时归一化弯引号后定位;返回文件实际子串,替换用文件自己的引号风格。
  const normalizedSearch = normalizeQuotes(search);
  const normalizedFile = normalizeQuotes(fileContent);
  const found = normalizedFile.indexOf(normalizedSearch);
  if (found === -1) return null;
  return fileContent.substring(found, found + search.length);
}

/** 数 `haystack` 中 `needle` 的非重叠出现次数。 */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/** 每行去尾部空白(空格/tab);Markdown 除外(行尾两空格是硬换行,裁剪改语义)。 */
export function stripTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/gm, '');
}

/**
 * 文件 old_string 含弯引号时,把 new_string 的直引号转回弯引号,保持文件排版风格。
 * 启发式:行首或前是空白/开括号→左引号,前是字母→右引号(撇号,如 don't),否则右引号。
 */
export function preserveQuoteStyle(actualOld: string, newString: string): string {
  if (!/[‘’“”]/.test(actualOld)) return newString; // 文件用直引号,无需转
  let result = '';
  for (let i = 0; i < newString.length; i++) {
    const ch = newString[i]!;
    const prev = i > 0 ? newString[i - 1]! : '';
    if (ch === "'") {
      result += prev === '' || /[\s([{\[]/.test(prev) ? '‘' : '’';
    } else if (ch === '"') {
      result += prev === '' || /[\s([{\[]/.test(prev) ? '“' : '”';
    } else {
      result += ch;
    }
  }
  return result;
}
