import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type ApiConfig } from "../../lib/api";
import { chainFor, discoverWallets, signIn, signOut, useSession, type Account, type WalletInfo } from "../../lib/wallet";
import SimChip from "../../components/SimChip";
import { Button, ErrorState, Panel } from "../../components/ui";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const usdc = (units: string | number | bigint) => {
  const n = BigInt(units);
  const s = (n < 0n ? -n : n).toString().padStart(7, "0");
  return `${n < 0n ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
};
export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—");
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message.split("\n")[0]! : "Something went wrong");

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(errText(e))).finally(() => live && setLoading(false));
    return () => void (live = false);
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export default function AppGate({ need, children }: { need?: "admin"; children: (cfg: ApiConfig, account: Account) => ReactNode }) {
  const session = useSession();
  const cfg = useAsync(() => api<ApiConfig>("/v1/config", { auth: false }));
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    discoverWallets().then(setWallets);
  }, []);

  if (cfg.error) return <ErrorState title="The testnet API is not reachable" body={`${cfg.error} The public simulations still work without it.`} onReset={cfg.reload} />;
  if (!cfg.data || session.status === "loading") return <p className="animate-pulse text-sm text-charcoal-60">Connecting to the testnet…</p>;
  const c = cfg.data;

  const header = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-white/60 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SimChip kind="Testnet" />
        <span>{chainFor(c.chainId).name}</span>
        <span className="text-charcoal-60">·</span>
        <span className="text-charcoal-60">{c.escrowAddress ? <>Escrow <span className="font-mono text-xs">{short(c.escrowAddress)}</span></> : "Escrow not deployed yet: test funding is simulated"}</span>
        {c.verifierMode === "fixture" && <span className="rounded-full bg-peach px-2 py-0.5 font-mono text-[11px]">pipeline test profile</span>}
      </div>
      {session.account && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{short(session.account.address)}</span>
          {session.account.isAdmin && <span className="rounded bg-charcoal px-1.5 font-mono text-[10px] text-paper">ADMIN</span>}
          <button type="button" className="min-h-9 rounded-full border border-charcoal/30 px-3 text-xs" onClick={() => signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );

  if (session.status !== "signed-in" || !session.account) {
    return (
      <>
        {header}
        <Panel title="Sign in with your wallet" chip={<SimChip kind="Testnet" />}>
          <p className="max-w-xl text-sm text-charcoal-80">Signing a message proves you control the address. It sends no transaction and costs no gas. Use a testnet-only wallet. Nothing here involves real money.</p>
          {wallets === null ? (
            <p className="mt-4 text-sm text-charcoal-60">Looking for browser wallets…</p>
          ) : wallets.length === 0 ? (
            <p className="mt-4 rounded-lg bg-peach-soft p-3 text-sm">No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload this page. The app adds Robinhood Chain Testnet to the wallet for you.</p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {wallets.map((w) => (
                <Button key={w.id} variant="accent" disabled={busy} onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try { await signIn(w, c); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
                }}>
                  {w.icon && <img src={w.icon} alt="" width={18} height={18} className="mr-1" />}Sign in with {w.name}
                </Button>
              ))}
            </div>
          )}
          {err && <p role="alert" className="mt-3 text-sm text-bad">{err}</p>}
        </Panel>
      </>
    );
  }
  if (need === "admin" && !session.account.isAdmin) {
    return <>{header}<Panel title="Admin only"><p className="text-sm">This address is not on the admin list for this deployment.</p></Panel></>;
  }
  return <>{header}{children(c, session.account)}</>;
}
