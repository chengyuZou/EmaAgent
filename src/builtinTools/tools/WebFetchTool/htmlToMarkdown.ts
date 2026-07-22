// 这里把 WebFetchTool 获取的基础 HTML 转成适合模型阅读的 Markdown 文本。
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, text) => `${'#'.repeat(Number(n))} ${stripTags(text)}\n\n`)
    .replace(/<\/?(p|div|section|article|main|header|footer|nav)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `**${stripTags(text)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => `_${stripTags(text)}_`)
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${stripTags(text)}](${href})`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code}\``)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `- ${stripTags(text).trim()}\n`)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').trim();
}
