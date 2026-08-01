/** 转义 SQLite LIKE 通配符(`%` `_` `\`),使用户输入按字面匹配。
 *  SQL 需配 `ESCAPE '\\'` 声明转义符。 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
