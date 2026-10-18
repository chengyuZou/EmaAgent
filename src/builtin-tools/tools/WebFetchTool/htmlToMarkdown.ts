import TurndownService from 'turndown';

const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// Turndown 本身不转换表格. 保留 table HTML, 不把参数名, 数值和列关系摊成一段文字.
service.keep('table');

export async function htmlToMarkdown(html: string): Promise<string> {
  return service.turndown(html);
}
