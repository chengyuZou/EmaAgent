import { Dialog } from './Dialog.js';
import { Callout } from './Callout.js';
import { Button } from './Button.js';

// ── ConfirmDialog ───────────────────────────────────────────────────────────
//
// Confirmation modal for destructive / irreversible actions. Replaces native
// confirm(). Built on Dialog + Callout + Button (all token-driven, light/dark
// safe). Esc / overlay-click = cancel.

export interface ConfirmDialogProps {
  open:         boolean;
  /** Dialog title. Defaults to "请确认". */
  title?:       string;
  /** Confirmation message shown inside a Callout. */
  message:      string;
  /** Confirm button label. Default "确认". */
  confirmText?: string;
  /** Cancel button label. Default "取消". */
  cancelText?:  string;
  /** Danger style (red Callout + danger confirm button). Default true. */
  danger?:      boolean;
  onConfirm:    () => void;
  onCancel:     () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  const {
    open,
    title,
    message,
    confirmText = '确认',
    cancelText  = '取消',
    danger      = true,
    onConfirm,
    onCancel,
  } = props;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title={title ?? '请确认'} hideClose>
      <Callout variant={danger ? 'danger' : 'info'}>{message}</Callout>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{cancelText}</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmText}</Button>
      </div>
    </Dialog>
  );
}
