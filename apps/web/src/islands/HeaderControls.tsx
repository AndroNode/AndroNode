import { useEffect, useState } from "react";
import { caState } from "@andronode/protocol/ca";
import type { SiteConfig } from "@andronode/protocol/config";
import Dialog from "../components/Dialog";
import { copyText } from "../lib/format";
import { motionPref, setMotion, type MotionPref } from "../lib/motion";

/** Header controls: CA chip, X control, wallet preview, motion toggle (PRD FR-01, FR-05, FR-14, FR-16, FR-17). */
export default function HeaderControls({ site, part = "utility" }: { site: SiteConfig; part?: "utility" | "wallet" }) {
  if (part === "wallet") return <WalletPreview site={site} />;
  return (
    <div className="flex items-center gap-2">
      <CaChip site={site} />
      <XControl site={site} />
      <MotionToggle />
    </div>
  );
}

function CaChip({ site }: { site: SiteConfig }) {
  const s = caState(site);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const base = "inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full border px-3 font-mono text-[11px] sm:min-h-10";
  if (s.kind !== "set") {
    return (
      <>
        <button type="button" className={`${base} border-charcoal/20 text-charcoal-60 hover:border-charcoal/40`} aria-describedby="ca-tip" onClick={() => setOpen(true)} title={s.tooltip}>
          <span aria-hidden="true">◇</span>
          {s.label}
        </button>
        <span id="ca-tip" className="sr-only">{s.tooltip}</span>
        <Dialog open={open} onClose={() => setOpen(false)} title={s.kind === "unset" ? "Contract address" : "Configuration error"}>
          <p className="font-medium">{s.tooltip}</p>
          <p className="mt-3 text-sm text-charcoal-60">
            No native token or token launch is confirmed. The whitepaper (§14) says the base protocol does not require one. Compute payments are designed in USDC. Copy is disabled until an owner-confirmed address is configured.
          </p>
        </Dialog>
      </>
    );
  }
  return (
    <button
      type="button"
      className={`${base} border-charcoal/30 hover:bg-peach`}
      title={s.tooltip}
      onClick={async () => setMsg((await copyText(s.address)) ? "Copied" : `Copy failed — select: ${s.address}`)}
      aria-live="polite"
    >
      {msg ?? s.label}
    </button>
  );
}

function XControl({ site }: { site: SiteConfig }) {
  const [open, setOpen] = useState(false);
  const icon = (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.4 4.7H5.58l11.09 14.5Z"/></svg>
  );
  const cls = "grid size-9 place-items-center rounded-full border border-charcoal/20 hover:bg-peach sm:size-10";
  if (site.social.x) {
    return <a className={cls} href={site.social.x} target="_blank" rel="noopener noreferrer" aria-label={`${site.displayName} on X`}>{icon}</a>;
  }
  return (
    <>
      <button type="button" className={cls} aria-label="X account" onClick={() => setOpen(true)}>{icon}</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Official X link not provided">
        <p>{site.displayName} has not published an official X account yet. This button will link to it once the project supplies a verified URL.</p>
        <p className="mt-3 text-sm text-charcoal-60">Be careful with accounts claiming to represent {site.displayName} until then.</p>
      </Dialog>
    </>
  );
}

function MotionToggle() {
  const [pref, setPref] = useState<MotionPref>("system");
  useEffect(() => setPref(motionPref()), []);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const on = pref === "on" || (pref === "system" && !reduced);
  return (
    <button
      type="button"
      className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-full border border-charcoal/20 px-3 text-[11px] hover:bg-peach sm:min-h-10"
      aria-pressed={!on}
      onClick={() => {
        const next: MotionPref = on ? "off" : "on";
        setMotion(next);
        setPref(next);
      }}
    >
      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${on ? "bg-orange" : "bg-charcoal/30"}`} />
      <span className="hidden sm:inline">Motion {on ? "on" : "off"}</span><span className="sm:hidden">{on ? "Motion" : "Still"}</span>
    </button>
  );
}

function WalletPreview({ site }: { site: SiteConfig }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null); // never persisted (FR-14)
  const submit = () => {
    const v = value.trim();
    if (!v) return setError("Enter a public address, or cancel.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return setError("That does not look like an EVM address (0x followed by 40 hex characters).");
    setLabel(`${v.slice(0, 6)}…${v.slice(-4)}`);
    setError(null);
    setOpen(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full bg-charcoal px-3 text-sm font-bold sm:px-4 text-paper hover:bg-charcoal-80">
        {label ? <><span className="font-mono text-xs">{label}</span><span className="rounded bg-peach px-1 font-mono text-[10px] text-charcoal">DEMO</span></> : <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect wallet</span></>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Connect wallet (preview)">
        <p className="text-sm">
          A real wallet connection is not available on these public pages. You can enter a <strong>public</strong> address to label this browser tab. It is only format-checked, never proves ownership and is not saved.
        </p>
        <ul className="mt-3 list-disc pl-5 text-sm text-charcoal-60">
          <li>No signature, transaction, chain switch or custody.</li>
          <li>Never enter a seed phrase or private key anywhere.</li>
          <li>Every demo works without an address.</li>
        </ul>
        <label className="mt-4 block text-sm font-bold" htmlFor="wallet-addr">Public address</label>
        <input
          id="wallet-addr"
          className="mt-1 w-full rounded-lg border border-charcoal/30 bg-white px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? "wallet-err" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {error && <p id="wallet-err" className="mt-2 text-sm text-bad">{error}</p>}
        <p className="mt-3 text-xs text-charcoal-60">Testnet features with a real wallet ({site.chain.name}) live in the Testnet App once it is enabled.</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {label && <button type="button" className="min-h-11 rounded-full border border-charcoal/30 px-4 text-sm" onClick={() => { setLabel(null); setValue(""); setOpen(false); }}>Disconnect</button>}
          <button type="button" className="min-h-11 rounded-full border border-charcoal/30 px-4 text-sm" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="min-h-11 rounded-full bg-charcoal px-4 text-sm font-bold text-paper" onClick={submit}>Use as demo label</button>
        </div>
      </Dialog>
    </>
  );
}
