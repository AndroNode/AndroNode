import { useEffect, useRef, type ReactNode } from "react";

/** Accessible modal on top of the native <dialog> element (focus trap and Escape built in). */
export default function Dialog({ open, onClose, title, children, labelledBy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const id = labelledBy ?? `dlg-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[min(92vw,30rem)] rounded-[var(--radius-card)] border border-line bg-paper p-0 text-charcoal shadow-xl backdrop:bg-charcoal/50"
    >
      <div className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 id={id} className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="-m-2 grid size-11 place-items-center rounded-full hover:bg-peach" aria-label="Close">
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
