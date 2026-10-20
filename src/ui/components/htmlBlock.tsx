import { memo, useEffect, useId, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { CodeViewer } from './codeViewer.js';
import { HtmlPreview } from './htmlPreview.js';
import { IconButton } from './IconButton.js';
import { Tooltip } from './Tooltip.js';

interface HtmlBlockProps {
  readonly source: string;
  /** WebFetch 的预览只使用返回文本的一部分, 源码和复制仍使用完整 source. */
  readonly previewSource?: string;
  readonly lineNumbers?: readonly string[];
  readonly wrapLines?: boolean;
  /** 流式代码围栏尚未闭合时, 显示源码但不加载预览. */
  readonly pending?: boolean;
  /** 外层提供标题和复制按钮. null 表示操作容器尚未挂载, undefined 表示独立卡片. */
  readonly toolbarContainer?: HTMLElement | null;
}

export const HtmlBlock = memo(function HtmlBlock({
  source,
  previewSource,
  lineNumbers,
  wrapLines = true,
  pending = false,
  toolbarContainer,
}: HtmlBlockProps): JSX.Element {
  const [showPreview, setShowPreview] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const contentId = useId();
  const embedded = toolbarContainer !== undefined;
  const previewVisible = showPreview && !pending;

  useEffect(() => {
    setCopyStatus('idle');
    return () => clearTimeout(copyTimer.current);
  }, [source]);

  async function copySource(): Promise<void> {
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(source);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
    copyTimer.current = setTimeout(() => setCopyStatus('idle'), 2500);
  }

  const previewButton = (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      title={pending ? '代码生成完整后可预览' : undefined}
      aria-controls={contentId}
      aria-pressed={previewVisible}
      onClick={() => setShowPreview(value => !value)}
    >
      {previewVisible ? '查看源码' : '查看预览'}
    </Button>
  );

  return (
    <div className={embedded ? 'ema-html-block' : 'ema-html-block ema-html-block--standalone'}>
      {!embedded && (
        <div className="ema-html-toolbar">
          <span>HTML</span>
          <div className="ema-html-actions">
            <span role="status">
              {copyStatus === 'copied' && '已复制'}
              {copyStatus === 'failed' && '复制失败, 请重试'}
            </span>
            {previewButton}
            <Tooltip content={copyStatus === 'copied' ? '已复制' : '复制全文'}>
              <IconButton
                shape="rounded"
                variant="ghost"
                size="sm"
                label="复制全文"
                icon={copyStatus === 'copied' ? 'i-lucide:check' : 'i-lucide:copy'}
                onClick={() => void copySource()}
              />
            </Tooltip>
          </div>
        </div>
      )}
      {toolbarContainer && createPortal(previewButton, toolbarContainer)}
      <div id={contentId}>
        <div className="ema-html-source ema-material-code" hidden={previewVisible}>
          <CodeViewer
            source={source}
            language="html"
            lineNumbers={lineNumbers}
            wrapLines={wrapLines}
            embedded
          />
        </div>
        {previewVisible && (
          <HtmlPreview source={previewSource ?? source} title="HTML 预览" />
        )}
      </div>
    </div>
  );
});
