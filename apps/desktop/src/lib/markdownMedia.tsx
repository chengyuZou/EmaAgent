import { createContext, useContext, useMemo, type ComponentProps, type JSX, type ReactNode } from 'react';
import { MarkdownLink, MarkdownRendererProvider } from '@ema-agent/ui';
import { AudioPlayer, isAudioSource } from './audio/audioPlayer.js';
import { MarkdownImage } from './images/markdownImage.js';

export interface MarkdownMediaProps {
  readonly children: ReactNode;
  /** 相对文件路径从这里解析; 聊天传 cwd, 文件预览传文件所在目录. */
  readonly directory?: string;
  /** 只通知文件侧栏打开绝对路径, 不在文字链接上显示播放器或读取文件. */
  readonly onOpenFile?: (absolutePath: string) => void;
  /** 页面或标签是否启用, 不是资源是否进入滚动视口. 隐藏时暂停音频. */
  readonly active?: boolean;
}

const MarkdownFiles = createContext<Omit<MarkdownMediaProps, 'children'> | null>(null);

function localFilePath(href: string, directory?: string): string | undefined {
  if (!href || /^(?:https?:|data:|blob:|\/\/|#)/i.test(href)) {
    return undefined;
  }
  let path = href;
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      path = decodeURIComponent(url.pathname);
      if (url.hostname) {
        path = `//${url.hostname}${path}`;
      } else if (/^\/[a-z]:\//i.test(path)) {
        path = path.slice(1);
      }
    } catch {
      return undefined;
    }
  } else {
    try {
      path = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '');
    } catch {
      path = href;
    }
  }
  const absolute = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path);
  if (!absolute) {
    if (!directory || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
      return undefined;
    }
    path = `${directory.replace(/[\\/]+$/, '')}/${path}`;
  }
  return path.replace(/\\/g, '/');
}

function mediaMarkdownUrl(url: string, key: string): string {
  const normalized = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^(?:https?:|mailto:|tel:|irc:|ircs:|xmpp:)/i.test(normalized)) {
    return url;
  }
  if (key === 'src' && /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(normalized)) {
    return url;
  }
  if (localFilePath(url) !== undefined) {
    return url;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return url;
  }
  return '';
}

// 标签组件的函数保持不变, 可变的目录与启用状态从 Context 读取.
// 如果切页时重新生成 img 组件, React 会卸载其中的播放器, 丢掉进度并重新读取图片.
const mediaComponents: ComponentProps<typeof MarkdownRendererProvider>['components'] = {
    img({ node: _node, src, alt, ...props }) {
      const files = useContext(MarkdownFiles);
      if (!src) {
        return null;
      }
      const path = localFilePath(src, files?.directory);
      if (isAudioSource(src)) {
        const title = alt || '音频';
        if (path) {
          return <AudioPlayer key={path} filePath={path} title={title} active={files?.active} />;
        }
        return <AudioPlayer key={src} src={src} title={title} active={files?.active} />;
      }
      if (path) {
        return <MarkdownImage key={path} {...props} filePath={path} alt={alt ?? '图片'} />;
      }
      return <MarkdownImage key={src} {...props} src={src} alt={alt ?? '图片'} />;
    },
    p({ node, children: content, ...props }) {
      function containsAudio(element: NonNullable<typeof node>): boolean {
        if (element.tagName === 'img' && typeof element.properties.src === 'string' && isAudioSource(element.properties.src)) {
          return true;
        }
        return element.children.some(child => child.type === 'element' && containsAudio(child));
      }
      // 播放器是块级卡片, 不能放进 p, 否则浏览器会拆开节点并破坏排版.
      if (node && containsAudio(node)) {
        return <div {...props} className="ema-markdown-media-paragraph">{content}</div>;
      }
      return <p {...props}>{content}</p>;
    },
    a({ node, href, title, children: linkText, ...props }) {
      const files = useContext(MarkdownFiles);
      const openFile = files?.onOpenFile;
      // 媒体自己处理点击, 不让外层链接同时触发文件打开或网页跳转.
      if (node?.children.some(child => child.type === 'element' && child.tagName === 'img')) {
        return <>{linkText}</>;
      }
      const path = href ? localFilePath(href, files?.directory) : undefined;
      return (
        <MarkdownLink
          {...props}
          href={href}
          title={title}
          onClick={event => {
            if (!path || !openFile) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            openFile(path);
          }}
        >
          {linkText}
        </MarkdownLink>
      );
    },
};

/**
 * 读取 Markdown 已解析的 img/a 标签, 不扫描普通文字或代码块中的路径.
 * 图片显示和音频播放各自负责; 此处只选组件, 提供文件目录、打开操作和页面是否启用.
 * 未提供的目录和文件打开操作从外层继承, 内层不能重新启用已隐藏页面的音频.
 */
export function MarkdownMedia({ children, directory, onOpenFile, active = true }: MarkdownMediaProps): JSX.Element {
  const parent = useContext(MarkdownFiles);
  const openFile = onOpenFile ?? parent?.onOpenFile;
  const enabled = active && parent?.active !== false;
  let mediaDirectory = directory ?? parent?.directory;
  if (directory && parent?.directory && !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(directory)) {
    mediaDirectory = `${parent.directory}/${directory}`;
  }
  const files = useMemo(() => ({
    directory: mediaDirectory,
    onOpenFile: openFile,
    active: enabled,
  }), [mediaDirectory, openFile, enabled]);

  return (
    <MarkdownFiles.Provider value={files}>
      <MarkdownRendererProvider components={mediaComponents} urlTransform={mediaMarkdownUrl}>
        {children}
      </MarkdownRendererProvider>
    </MarkdownFiles.Provider>
  );
}
