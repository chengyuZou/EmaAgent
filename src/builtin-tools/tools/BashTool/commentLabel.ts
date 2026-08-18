// 提取命令首行的 # 注释作为展示标签(shebang 不算)。
// 用户/模型给人看的说明写在命令首行注释里, 展示层拿来当标题。
export function extractBashCommentLabel(command: string): string | undefined {
  const newlineIndex = command.indexOf('\n');
  const firstLine = (newlineIndex === -1 ? command : command.slice(0, newlineIndex)).trim();
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined;
  return firstLine.replace(/^#+\s*/, '') || undefined;
}
