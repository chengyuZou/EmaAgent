// Edit 和覆盖 Write 共用补丁显示; 差异解析、高亮、行号与排版由 @pierre/diffs 负责.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { formatPatch, type StructuredPatchHunk } from 'diff';
import { PatchDiff, type PatchDiffProps } from '@pierre/diffs/react';
import diffCSS from '@ema-agent/builtin-tools/fileDiff.css?inline';

export function FilePatchView({ filePath, hunks }: {
  filePath: string;
  hunks: readonly StructuredPatchHunk[];
}): JSX.Element {
  const [themeType, setThemeType] = useState<'light' | 'dark'>(() => (
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  ));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeType(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const patch = useMemo(() => {
    const path = filePath.replace(/\\/g, '/');
    // 官方序列化负责文件名转义和 hunk 边界, 不再手工拼接补丁头.
    return formatPatch({
      isGit: true,
      oldFileName: `a/${path}`,
      newFileName: `b/${path}`,
      oldHeader: '',
      newHeader: '',
      hunks: [...hunks],
    });
  }, [filePath, hunks]);
  const options = useMemo<PatchDiffProps<undefined, undefined>['options']>(() => ({
    theme: { light: 'github-light', dark: 'github-dark' },
    themeType,
    diffStyle: 'unified',
    diffIndicators: 'classic',
    overflow: 'scroll',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    disableFileHeader: true,
    unsafeCSS: diffCSS,
  }), [themeType]);

  if (hunks.length === 0) {
    return <span className="text-[11px] text-[var(--ema-text-tertiary)]">内容未变化</span>;
  }
  return (
    <PatchDiff
      patch={patch}
      options={options}
      style={{ fontFamily: 'var(--ema-font-mono)', fontSize: '12px' }}
    />
  );
}
