import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { escrowAbi } from "@andronode/protocol/abi";
import { canonicalJson, digestOf, sha256Hex } from "@andronode/protocol/hash";
import { fixtureEmbedding } from "@andronode/protocol/fixture-embed";
import { api, type ApiConfig } from "../../lib/api";
import { idbDel, idbGet, idbSet } from "../../lib/idb";
import { walletOnChain } from "../../lib/wallet";
import Companion from "../../components/Companion";
import SimChip from "../../components/SimChip";
import { Button, EmptyState, Field, Panel, Select, StatusBadge, type StatusTone } from "../../components/ui";
import AppGate, { errText, short, usdc, useAsync, when } from "./AppGate";
import type { Account } from "../../lib/wallet";

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
interface StoredNode { deviceId: string; key: CryptoKey }

/** A real test node running in this tab: signed requests, leases, fixture computation and on-time submission. */
function BrowserNode({ cfg, account, onChange }: { cfg: ApiConfig; account: Account; onChange: () => void }) {
  const storeKey = `node:${account.id}`;
  const [node, setNode] = useState<StoredNode | null | undefined>(undefined);
  const [status, setStatus] = useState<{ tone: StatusTone; label: string }>({ tone: "idle", label: "Ready" });
  const [minutes, setMinutes] = useState("30");
  const [log, setLog] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const running = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const add = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 60));

  useEffect(() => { idbGet<StoredNode>(storeKey).then((n) => setNode(n ?? null)).catch(() => setNode(null)); }, [storeKey]);
  useEffect(() => () => void (running.current = false), []);

  const signed = async (path: string, json?: unknown) => {
    const n = node!;
    const method = json === undefined ? "GET" : "POST";
    const body = json === undefined ? "" : JSON.stringify(json);
    const ts = String(Date.now());
    const sig = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, n.key, new TextEncoder().encode(`AN1\n${method}\n${path}\n${ts}\n${await sha256Hex(body)}`)));
    return api<any>(path, { method, json, auth: false, headers: { "x-an-device": n.deviceId, "x-an-ts": ts, "x-an-sig": sig } });
  };

  const register = async () => {
    try {
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
      const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
      const ch = await api<{ challenge: string; sign: string }>("/v1/devices/challenge", { method: "POST" });
      const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(ch.sign)));
      const r = await api<{ device: { id: string } }>("/v1/devices/register", { json: { publicKeyJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y }, formFactor: "test-node", label: "Browser test node", challenge: ch.challenge, signature } });
      const stored = { deviceId: r.device.id, key: pair.privateKey };
      await idbSet(storeKey, stored);
      setNode(stored);
      add(`Registered ${r.device.id}. New devices start in probation with a $1 provisional cap.`);
      onChange();
    } catch (e) { add(`Registration failed: ${errText(e)}`); }
  };

  const start = async () => {
    if (!node) return;
    running.current = true;
    setIsRunning(true);
    try {
      const s = await signed("/v1/node/sessions/start", { minutes: Number(minutes) });
      add(`Session started until ${new Date(s.session.endsAt).toLocaleTimeString()}`);
      while (running.current && Date.now() < s.session.endsAt) {
        const acq = await signed("/v1/node/leases/acquire", {});
        if (!acq.lease) {
          setStatus({ tone: "idle", label: acq.status === "WAITING_FOR_WORK" ? "Waiting for work" : acq.status.replace(/_/g, " ").toLowerCase() });
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        const lease = acq.lease;
        setStatus({ tone: "busy", label: "Working" });
        const inp = await signed(`/v1/node/leases/${lease.lease_id}/input`);
        if (!running.current) break;
        const outputs = inp.records.map((r: { id: string; text: string }) => ({ id: r.id, vector: fixtureEmbedding(r.text) }));
        const core = { lease_id: lease.lease_id, output_digest: await digestOf(outputs), completed_record_count: outputs.length, execution_status: "COMPLETED", profile_id: lease.profile_id };
        const sig = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, node.key, new TextEncoder().encode(canonicalJson(core))));
        const sub = await signed(`/v1/node/leases/${lease.lease_id}/result`, { ...core, outputs, device_signature: sig });
        setStatus({ tone: "busy", label: "Verifying" });
        setCount((c) => c + 1);
        add(`Task with ${lease.record_count} records submitted (${sub.state}). Reward if accepted: ${usdc(lease.reward_units)} USDC`);
        onChange();
      }
    } catch (e) { add(`Stopped: ${errText(e)}`); }
    running.current = false;
    setIsRunning(false);
    await signed("/v1/node/sessions/stop", {}).catch(() => {});
    setStatus({ tone: "idle", label: "Stopped" });
  };

  const stop = async () => {
    running.current = false;
    setIsRunning(false);
    const r = await signed("/v1/node/sessions/stop", {}).catch((e) => ({ error: errText(e) }));
    add(r.returnedLeases?.length ? "Stopped. The unfinished task was returned with no penalty." : "Stopped.");
    setStatus({ tone: "idle", label: "Stopped" });
  };

  if (cfg.verifierMode !== "fixture") {
    return <Panel title="Browser test node"><p className="text-sm">This deployment verifies real model output, so the in-browser node is off. Use the command-line test node or an Android build of the client.</p></Panel>;
  }
  return (
    <Panel title="Browser test node" chip={<SimChip kind="Testnet" />}>
      <p className="text-sm text-charcoal-80">Runs the pipeline test profile in this tab: it leases real tasks, computes the deterministic test vectors and submits signed results. It does not use your device's sensors or permissions.</p>
      {node === undefined ? null : node === null ? (
        <div className="mt-4"><Button variant="accent" onClick={register}>Register this browser as a test node</Button></div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Companion size={36} color={status.tone === "busy" ? "#F07843" : "#ECEEF3"} />
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            <span className="font-mono text-xs text-charcoal-60">{node.deviceId} · {count} submitted</span>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field label="Session" htmlFor="bn-min"><Select id="bn-min" value={minutes} onChange={setMinutes} options={[{ value: "5", label: "5 minutes" }, { value: "30", label: "30 minutes" }, { value: "120", label: "2 hours" }]} /></Field>
            {isRunning ? <Button variant="primary" onClick={stop}>Stop</Button> : <Button variant="accent" onClick={start}>Start session</Button>}
            {!isRunning && <button type="button" className="min-h-11 text-xs underline" onClick={async () => { await idbDel(storeKey); setNode(null); }}>Forget this node</button>}
          </div>
          <ol className="mt-4 max-h-48 overflow-auto rounded-lg bg-charcoal/[0.03] p-3 font-mono text-xs" aria-live="polite">{log.length ? log.map((l, i) => <li key={i}>{l}</li>) : <li>No activity yet.</li>}</ol>
        </>
      )}
    </Panel>
  );
}

function Rewards({ cfg, account }: { cfg: ApiConfig; account: Account }) {
  const r = useAsync(() => api<any>("/v1/rewards"));
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(r.reload, 6000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (r.error) return <Panel title="Rewards"><p className="text-sm text-bad">{r.error}</p></Panel>;
  if (!r.data) return <Panel title="Rewards"><p className="text-sm text-charcoal-60">Loading…</p></Panel>;
  const d = r.data;
  const withdraw = async () => {
    setMsg(null);
    try {
      const { wallet, publicClient, address } = await walletOnChain(cfg);
      if (address.toLowerCase() !== account.address) throw new Error("Switch your wallet to the signed-in address first");
      const h = await wallet.writeContract({ account: address, address: cfg.escrowAddress as Hex, abi: escrowAbi, functionName: "withdraw", args: [BigInt(d.claimable.units), address] });
      setMsg("Withdrawal sent. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash: h });
      setMsg("Withdrawn to your wallet.");
      r.reload();
    } catch (e) { setMsg(errText(e)); }
  };
  const cards: [string, string, string][] = [
    ["Provisional", d.provisional.units, `Accepted, in the review window (${cfg.reviewWindowSeconds >= 3600 ? `${Math.round(cfg.reviewWindowSeconds / 3600)} h` : `${Math.max(1, Math.round(cfg.reviewWindowSeconds / 60))} min`} here). Not yet money you can move.`],
    ["Held", d.held.units, "Paused by an open dispute. Not deleted."],
    ["Claimable", d.claimable.units, d.claimable.source === "chain" ? "Credited on the escrow contract. Withdraw any time." : "Credited by settlement (simulated on this deployment)."],
    ["Withdrawn", d.withdrawn.units, "Sent to your wallet."],
  ];
  return (
    <Panel title="Rewards" chip={<SimChip kind="Testnet" />}>
      <dl className="grid gap-3 sm:grid-cols-4">
        {cards.map(([k, v, hint]) => (
          <div key={k} className="rounded-lg border border-line p-3"><dt className="text-sm text-charcoal-60">{k}</dt><dd className="font-mono text-lg tabular">{usdc(v)}</dd><dd className="text-[11px] text-charcoal-60">{hint}</dd></div>
        ))}
      </dl>
      {d.claimable.source === "chain" && BigInt(d.claimable.units) > 0n && <div className="mt-4"><Button variant="accent" onClick={withdraw}>Withdraw {usdc(d.claimable.units)} test USDC</Button></div>}
      {msg && <p className="mt-2 text-sm" role="status">{msg}</p>}
      <h3 className="mt-6 font-bold">Recent accepted tasks</h3>
      {d.recent.length === 0 ? <p className="mt-2 text-sm text-charcoal-60">Nothing yet. Rewards appear only after verified work on paid orders.</p> : (
        <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-charcoal-60"><tr><th className="py-1 font-normal">Receipt</th><th className="font-normal">Reward</th><th className="font-normal">State</th><th className="font-normal">Review ends</th></tr></thead>
          <tbody>{d.recent.map((x: any) => <tr key={x.id} className="border-t border-line"><td className="py-1 font-mono text-xs">{x.receipt_id}</td><td className="font-mono">{usdc(x.units)}</td><td>{x.state.toLowerCase()}</td><td className="text-xs">{when(x.available_at)}</td></tr>)}</tbody>
        </table></div>
      )}
      {d.rejections.length > 0 && (
        <>
          <h3 className="mt-6 font-bold">Rejections</h3>
          <ul className="mt-2 grid gap-1 text-sm">{d.rejections.map((x: any) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2"><span><span className="font-mono text-xs">{x.reason}</span> · {when(x.created_at)}</span>
              <button type="button" className="min-h-9 text-xs underline" onClick={async () => { const reason = prompt("Why should this be reviewed? (at least 10 characters)"); if (!reason) return; try { await api("/v1/rewards/appeals", { json: { receiptId: x.id, reason } }); setMsg("Appeal filed."); } catch (e) { setMsg(errText(e)); } }}>Appeal</button></li>
          ))}</ul>
        </>
      )}
    </Panel>
  );
}

function Devices({ tick }: { tick: number }) {
  const d = useAsync(() => api<{ devices: any[] }>("/v1/devices"), [tick]);
  return (
    <Panel title="Your devices" actions={<button type="button" className="min-h-9 text-xs underline" onClick={d.reload}>Refresh</button>}>
      {d.data?.devices.length === 0 && <EmptyState title="No devices yet" body="Register this browser below, or run the command-line test node." />}
      <ul className="grid gap-2">{d.data?.devices.map((x) => (
        <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
          <span><span className="font-bold">{x.label ?? x.form_factor}</span> <span className="font-mono text-xs text-charcoal-60">{short(x.id)}</span></span>
          <span className="text-xs">{x.accepted_tasks} accepted · {x.rejected_tasks} rejected</span>
          <StatusBadge tone={x.status === "active" ? "ok" : x.status === "probation" ? "warn" : "idle"}>{x.status}</StatusBadge>
          {x.status !== "revoked" && <button type="button" className="min-h-9 text-xs underline" onClick={async () => { if (confirm("Revoke this device key? It cannot be undone.")) { await api(`/v1/devices/${x.id}/revoke`, { method: "POST" }); d.reload(); } }}>Revoke</button>}
        </li>
      ))}</ul>
      <details className="mt-4 text-sm"><summary className="cursor-pointer font-bold">Run the command-line test node</summary>
        <pre className="mt-2 overflow-x-auto zone-dark rounded-lg bg-charcoal p-3 font-mono text-xs text-paper ring-1 ring-white/5">{`git clone <repo> && cd andronode && pnpm install
API_URL=${typeof location !== "undefined" ? location.origin : ""} WALLET_PRIVATE_KEY=<testnet-only key> \\
  pnpm --filter @andronode/test-node start node --minutes 30`}</pre>
      </details>
    </Panel>
  );
}

function Contributor({ cfg, account }: { cfg: ApiConfig; account: Account }) {
  const [tick, setTick] = useState(0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid content-start gap-6"><BrowserNode cfg={cfg} account={account} onChange={() => setTick((t) => t + 1)} /><Devices tick={tick} /></div>
      <Rewards cfg={cfg} account={account} />
    </div>
  );
}

export default function ContributorApp() {
  return <AppGate>{(cfg, account) => <Contributor cfg={cfg} account={account} />}</AppGate>;
}
