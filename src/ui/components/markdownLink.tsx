import type { ComponentProps, JSX } from 'react';
import { Tooltip } from './Tooltip.js';

/** 只显示链接和完整地址提示. 本地读取与打开文件由应用提供 onClick, 不在 UI 包执行. */
export function MarkdownLink({ href, title, children, ...props }: ComponentProps<'a'>): JSX.Element {
  const external = href !== undefined && /^https?:\/\//i.test(href);
  return (
    <Tooltip
      variant="card"
      content={href && (
        <>
          {title && <div className="mb-1 font-medium">{title}</div>}
          <div>{href}</div>
        </>
      )}
    >
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    </Tooltip>
  );
}
