/**
 * 按各组的排名交替取项, 如 [a1,a2] 与 [b1,b2] 得到 a1,b1,a2,b2, 不把第一组全部排在前面.
 * identify 返回实体名、关系 ID 或块 ID; 重复身份只保留首次出现的项, 不比较正文是否相同.
 */
export function mergeAlternating<T, K>(
  groups: readonly (readonly T[])[],
  identify: (item: T) => K,
): T[] {
  const result: T[] = [];
  const seen = new Set<K>();
  const length = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < length; index++) {
    for (const group of groups) {
      const item = group[index];
      if (item === undefined) {
        continue;
      }
      const id = identify(item);
      if (!seen.has(id)) {
        seen.add(id);
        result.push(item);
      }
    }
  }
  return result;
}
