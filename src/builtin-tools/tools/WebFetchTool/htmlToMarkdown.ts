// HTML → Markdown 转换: turndown 懒加载单例, 首次真正转换时才加载(~1.4MB), 之后复用。
type TurndownCtor = typeof import('turndown');

let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined;

export async function htmlToMarkdown(html: string): Promise<string> {
  const service = await (turndownServicePromise ??= import('turndown').then((module) => {
    // turndown 是 CJS, NodeNext 下动态 import 的 default 才是构造器。
    const Turndown = (module as unknown as { default: TurndownCtor }).default;
    // atx 标题 + fenced 代码块比 turndown 默认的 setext/indented 更适合模型阅读。
    return new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }));
  return service.turndown(html);
}
