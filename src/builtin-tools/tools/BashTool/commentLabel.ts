export function extractBashCommentLabel(command: string): string | undefined {
  const newlineIndex = command.indexOf('\n');
  const firstLine = (newlineIndex === -1 ? command : command.slice(0, newlineIndex)).trim();
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined;
  return firstLine.replace(/^#+\s*/, '') || undefined;
}
