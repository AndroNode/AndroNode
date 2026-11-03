import type { ReactNode } from "react";

export function Panel({ title, chip, children, className = "", actions }: { title: string; chip?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section data-spotlight className={`min-w-0 rounded-[var(--radius-card)] border border-line bg-white/60 p-5 sm:p-6 ${className}`} aria-label={title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        <div className="flex items-center gap-2">{actions}{chip}</div>
      </div>
      {children}
    </section>
  );
}

export function Button({ children, onClick, variant = "primary", disabled, type = "button", className = "", ariaLabel }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "accent" | "ghost" | "danger"; disabled?: boolean; type?: "button" | "submit"; className?: string; ariaLabel?: string }) {
  const v = {
    primary: "bg-charcoal text-paper hover:bg-charcoal-80",
    accent: "bg-orange text-ink hover:brightness-105",
    ghost: "border border-charcoal/30 hover:bg-peach",
    danger: "border border-bad/40 text-bad hover:bg-bad/5",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${v} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-bold">{label}</label>
      {hint && <p className="text-xs text-charcoal-60">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function Select({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-11 w-full rounded-lg border border-charcoal/30 bg-white px-3 text-sm">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-charcoal/20 bg-white px-3 text-left text-sm">
      <span>{label}</span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-charcoal" : "bg-charcoal/25"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-paper shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

export function Range({ id, value, min, max, step = 1, onChange, suffix }: { id: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-3">
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-11 flex-1 accent-orange" />
      <output htmlFor={id} className="w-20 text-right font-mono text-sm tabular">{value}{suffix}</output>
    </div>
  );
}

export type StatusTone = "ok" | "warn" | "bad" | "idle" | "busy";
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const map: Record<StatusTone, [string, string]> = {
    ok: ["bg-ok/10 text-ok border-ok/30", "✓"],
    warn: ["bg-warn/10 text-warn border-warn/30", "!"],
    bad: ["bg-bad/10 text-bad border-bad/30", "×"],
    idle: ["bg-charcoal/5 text-charcoal-60 border-charcoal/20", "○"],
    busy: ["bg-peach text-charcoal border-orange/40", "◐"],
  };
  const [cls, icon] = map[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${cls}`}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-charcoal/25 p-6 text-center">
      <p className="font-bold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-charcoal-60">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, body, onReset }: { title: string; body: string; onReset: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-bad/30 bg-bad/5 p-5">
      <p className="font-bold text-bad">{title}</p>
      <p className="mt-1 text-sm">{body}</p>
      <div className="mt-3"><Button variant="ghost" onClick={onReset}>Reset</Button></div>
    </div>
  );
}
