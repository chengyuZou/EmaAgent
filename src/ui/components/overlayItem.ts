// 浮层选项的统一配方: Select 与 DropdownMenu 共用, 不再各自复制一份.
export const overlayItemCn =
  'flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm cursor-pointer ' +
  'outline-none transition-ema ' +
  'data-[highlighted]:bg-[var(--ema-primary-muted)] data-[highlighted]:text-[var(--ema-primary-text)] ' +
  'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed';

export const overlayItemDangerCn =
  'data-[highlighted]:bg-[var(--ema-danger-muted)] data-[highlighted]:text-[var(--ema-danger-text)] text-[var(--ema-danger-text)]';
