import { useEffect, useState } from "react";
import { caState } from "@andronode/protocol/ca";
import type { SiteConfig } from "@andronode/protocol/config";
import Dialog from "../components/Dialog";
import { copyText } from "../lib/format";
import { api, sessionToken, type ApiConfig } from "../lib/api";
import type { SessionState, WalletInfo } from "../lib/wallet";
import { motionPref, setMotion, type MotionPref } from "../lib/motion";

/** Header controls: CA chip, X control, wallet sign-in, motion toggle (PRD FR-01, FR-05, FR-14, FR-16, FR-17). */
export default function HeaderControls({ site, part = "utility" }: { site: SiteConfig; part?: "utility" | "wallet" }) {
  if (part === "wallet") return <WalletButton site={site} />;
  return (
    <div className="flex items-center gap-2">
      <CaChip site={site} />
      <XControl site={site} />
      <GithubLink site={site} />
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
            No native token or token launch is confirmed. The protocol design (§14) says the base protocol does not require one. Compute payments are designed in USDC. Copy is disabled until an owner-confirmed address is configured.
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

function GithubLink({ site }: { site: SiteConfig }) {
  if (!site.social.github) return null;
  return (
    <a
      className="grid size-9 place-items-center rounded-full border border-charcoal/20 hover:bg-peach sm:size-10"
      href={site.social.github}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${site.displayName} on GitHub`}
      title="GitHub"
    >
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.08-.12-.3-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.75.11 3.05.74.8 1.19 1.82 1.19 3.08 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>
    </a>
  );
}

function MotionToggle() {
  const [pref, setPref] = useState<MotionPref>("system");
  // Read the OS setting after hydration, so the first client render matches the server's HTML.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setPref(motionPref());
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
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

type WalletMod = typeof import("../lib/wallet");

/**
 * Header wallet button. Signs in with Ethereum (EIP-4361) on the testnet, shared with the /app pages.
 * The wallet code loads only when needed: on click, or when a saved session exists.
 */
function WalletButton({ site }: { site: SiteConfig }) {
  const [mod, setMod] = useState<WalletMod | null>(null);
  const [sess, setSess] = useState<SessionState | null>(null);
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<ApiConfig | null>(null);
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let unsub: (() => void) | null = null;
    const attach = async () => {
      if (unsub) return;
      const m = await import("../lib/wallet");
      if (!live || unsub) return;
      setMod(m);
      unsub = m.subscribeSession((s) => live && setSess({ ...s }));
    };
    if (sessionToken()) attach();
    window.addEventListener("an-session", attach);
    return () => { live = false; unsub?.(); window.removeEventListener("an-session", attach); };
  }, []);

  const signedIn = sess?.status === "signed-in" && sess.account;

  // Load what the dialog needs when it opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setErr(null); setNote(null);
    (async () => {
      try {
        const m = mod ?? (await import("../lib/wallet"));
        if (!live) return;
        if (!mod) { setMod(m); m.subscribeSession((s) => live && setSess({ ...s })); }
        const c = cfg ?? (await api<ApiConfig>("/v1/config", { auth: false }));
        if (!live) return;
        setCfg(c);
        if (!wallets) m.discoverWallets().then((w) => live && setWallets(w));
      } catch (e) { if (live) setErr(errMsg(e)); }
    })();
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settlement-asset balance for the signed-in address.
  useEffect(() => {
    if (!open || !signedIn || !mod || !cfg) return;
    let live = true;
    setBalance(undefined);
    mod.assetBalance(cfg, sess!.account!.address).then((b) => live && setBalance(b)).catch(() => live && setBalance(null));
    return () => { live = false; };
  }, [open, signedIn, mod, cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = signedIn ? `${sess!.account!.address.slice(0, 6)}…${sess!.account!.address.slice(-4)}` : null;
  const chainName = cfg && mod ? mod.chainFor(cfg.chainId).name : site.chain.name;
  const units = (b: bigint, d: number) => { const s = b.toString().padStart(d + 1, "0"); return `${s.slice(0, -d)}.${s.slice(-d, -d + 2)}`; };
  const btn = "min-h-11 rounded-full border border-charcoal/30 px-4 text-sm hover:bg-peach";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full bg-charcoal px-3 text-sm font-bold text-paper hover:bg-charcoal-80 sm:px-4" aria-label={label ? `Wallet ${label}` : "Connect wallet"}>
        {label ? <><span aria-hidden="true" className="size-2 rounded-full bg-ok" /><span className="font-mono text-xs">{label}</span>{sess!.account!.isAdmin && <span className="hidden rounded bg-orange px-1 font-mono text-[10px] text-paper sm:inline">ADMIN</span>}</> : <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect wallet</span></>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={signedIn ? "Your testnet wallet" : "Connect wallet"}>
        {signedIn ? (
          <div className="grid gap-4 text-sm">
            <div className="rounded-lg border border-line p-3">
              <p className="text-charcoal-60">Signed in as {sess!.account!.isAdmin && <span className="ml-1 rounded bg-orange px-1 font-mono text-[10px] text-paper">ADMIN</span>}</p>
              <p className="mt-1 break-all font-mono text-xs">{sess!.account!.address}</p>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                <div><dt className="text-charcoal-60">Network</dt><dd>{chainName}</dd></div>
                <div><dt className="text-charcoal-60">{cfg?.settlementAsset.symbol ?? "tUSDC"} balance</dt><dd className="font-mono">{balance === undefined ? "…" : balance === null ? "n/a" : units(balance, cfg?.settlementAsset.decimals ?? 6)}</dd></div>
              </dl>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={async () => setNote((await copyText(sess!.account!.address)) ? "Address copied." : "Copy failed.")}>Copy address</button>
              {cfg && mod && <button type="button" className={btn} disabled={busy} onClick={async () => {
                setBusy(true); setErr(null);
                try { await mod.walletOnChain(cfg); setNote(`Wallet is on ${chainName}.`); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
              }}>Switch wallet network</button>}
            </div>
            <nav aria-label="Testnet app" className="grid grid-cols-2 gap-2">
              <a href="/app/contributor" className="rounded-lg border border-line p-3 hover:bg-peach"><span className="font-bold">Contributor</span><span className="block text-xs text-charcoal-60">Devices and rewards</span></a>
              <a href="/app/customer" className="rounded-lg border border-line p-3 hover:bg-peach"><span className="font-bold">Customer</span><span className="block text-xs text-charcoal-60">Orders and test funds</span></a>
              {sess!.account!.isAdmin && <a href="/app/admin" className="col-span-2 rounded-lg border border-line p-3 hover:bg-peach"><span className="font-bold">Admin</span><span className="block text-xs text-charcoal-60">Settlements, disputes, devices</span></a>}
            </nav>
            {note && <p role="status" className="text-charcoal-60">{note}</p>}
            {err && <p role="alert" className="text-bad">{err}</p>}
            <div className="flex justify-end">
              <button type="button" className={btn} onClick={async () => { await mod?.signOut(); setOpen(false); }}>Sign out</button>
            </div>
          </div>
        ) : (
          <div className="text-sm">
            <p>Sign a message to prove you control the address. It sends no transaction and costs no gas. Use a testnet-only wallet: nothing here involves real money.</p>
            {err ? <p role="alert" className="mt-4 text-bad">{err}</p> : wallets === null ? (
              <p className="mt-4 animate-pulse text-charcoal-60">Looking for browser wallets…</p>
            ) : wallets.length === 0 ? (
              <p className="mt-4 rounded-lg bg-peach-soft p-3">No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload. {site.chain.name} is added to the wallet for you.</p>
            ) : (
              <div className="mt-4 grid gap-2">
                {wallets.map((w) => (
                  <button key={w.id} type="button" disabled={busy || !cfg} className="flex min-h-12 items-center gap-3 rounded-xl border border-charcoal/20 px-4 text-left font-bold hover:bg-peach disabled:opacity-60" onClick={async () => {
                    if (!mod || !cfg) return;
                    setBusy(true); setErr(null);
                    try { await mod.signIn(w, cfg); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
                  }}>
                    {w.icon ? <img src={w.icon} alt="" width={24} height={24} /> : <span aria-hidden="true" className="grid size-6 place-items-center rounded bg-charcoal/10">◇</span>}
                    {busy ? "Check your wallet…" : w.name}
                  </button>
                ))}
              </div>
            )}
            <ul className="mt-4 list-disc pl-5 text-charcoal-60">
              <li>Never enter a seed phrase or private key anywhere.</li>
              <li>Every demo on this site works without a wallet.</li>
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}

const errMsg = (e: unknown) => {
  const m = e instanceof Error ? e.message.split("\n")[0]! : "Something went wrong";
  return /user rejected|denied/i.test(m) ? "Request cancelled in the wallet." : m;
};
