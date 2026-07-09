import { useRef, type ReactNode, type ChangeEvent } from 'react';
import { cn } from '../utils/cn.js';

// ── FilePicker ───────────────────────────────────────────────────────────────
//
// Hidden native <input type="file"> wrapped behind a trigger. Lets call sites
// avoid raw <input> (CLAUDE.md red line) while keeping the native file dialog.
// For directory picks or Tauri-managed dialogs, use tauriBridge.openFileDialog
// directly instead.

export interface FilePickerProps {
  /** accept attribute, e.g. "image/*", ".json,.csv". */
  accept?:    string;
  multiple?:  boolean;
  onSelect:   (files: File[]) => void;
  /** Trigger content (rendered inside a <button>). */
  children:   ReactNode;
  className?: string;
  disabled?:  boolean;
}

export function FilePicker(props: FilePickerProps): React.JSX.Element {
  const { accept, multiple = false, onSelect, children, className, disabled } = props;
  const ref = useRef<HTMLInputElement>(null);

  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onSelect(files);
    e.target.value = '';
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        className={cn('inline-flex items-center justify-center', className)}
        onClick={() => ref.current?.click()}
      >
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={onChange}
      />
    </>
  );
}
