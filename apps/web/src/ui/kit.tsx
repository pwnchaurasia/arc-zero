import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { sfx } from "../feel/audio";
import { BackIcon, StarIcon } from "./icons";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-ink hover:brightness-110 active:brightness-95",
  secondary: "bg-panel-2 text-white border border-line hover:bg-line",
  ghost: "bg-transparent text-muted hover:text-white",
};

export function Button({
  variant = "primary",
  className = "",
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      onClick={(e) => {
        sfx.unlock();
        sfx.tap();
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

export function IconButton({
  label,
  badge,
  className = "",
  onClick,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; badge?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`relative grid size-11 place-items-center rounded-2xl bg-panel-2 text-white transition hover:bg-line active:scale-95 disabled:opacity-40 ${className}`}
      onClick={(e) => {
        sfx.unlock();
        sfx.tap();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
      {badge !== undefined && (
        <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-gold text-[11px] font-bold text-ink">
          {badge}
        </span>
      )}
    </button>
  );
}

export function Stars({ count, size = 18 }: { count: number; size?: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${count} of 3 stars`}>
      {[1, 2, 3].map((i) => (
        <StarIcon key={i} size={size} filled={i <= count} className={i <= count ? "text-gold" : "text-line"} />
      ))}
    </span>
  );
}

export function TopBar({
  title,
  onBack,
  right,
}: {
  title: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 px-4 py-3">
      {onBack && (
        <IconButton label="Back" onClick={onBack}>
          <BackIcon />
        </IconButton>
      )}
      <h1 className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h1>
      {right}
    </header>
  );
}

/** Accessible modal dialog built on <dialog> (focus trap and Escape handling for free). */
export function Modal({
  open,
  onClose,
  title,
  children,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="m-auto w-[min(92vw,420px)] rounded-3xl border border-line bg-panel p-0 text-white shadow-2xl backdrop:bg-black/70"
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onClose();
      }}
    >
      {open && (
        <div className="pop-in p-6">
          <h2 className="mb-3 text-xl font-bold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
      <span>{label}</span>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="relative h-7 w-12 rounded-full bg-line transition peer-checked:bg-accent after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-white" />
    </label>
  );
}
