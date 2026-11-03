import { useState } from "react";
import { api, type ApiConfig } from "../../lib/api";
import { copyText } from "../../lib/format";
import { Button, Panel, StatusBadge } from "../../components/ui";
import AppGate, { errText, short, usdc, useAsync, when } from "./AppGate";

function Overview() {
  const o = useAsync(() => api<any>("/v1/admin/overview"));
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  if (o.error) return <Panel title="Overview"><p className="text-sm text-bad">{o.error}</p></Panel>;
  if (!o.data) return <Panel title="Overview"><p className="text-sm text-charcoal-60">Loading…</p></Panel>;
  const d = o.data;
  const exp = Number(d.exposure.unsettledUnits) / Number(d.exposure.capUnits);
  const row = (rows: any[], k: string) => rows.map((r) => `${String(r[k]).toLowerCase()} ${r.n}`).join(" · ") || "none";
  return (
    <Panel title="Overview" actions={<div className="flex gap-2"><button type="button" className="min-h-9 text-xs underline" onClick={o.reload}>Refresh</button><button type="button" className="min-h-9 text-xs underline" onClick={async () => { try { const r = await api<any>("/v1/admin/sync", { method: "POST" }); setSyncMsg(`Swept ${r.sweep.expired} expired lease(s). Chain: ${r.chain ? `${r.chain.processed} event(s) to block ${r.chain.toBlock}` : "not configured"}.`); o.reload(); } catch (e) { setSyncMsg(errText(e)); } }}>Run sync now</button></div>}>
      {syncMsg && <p className="mb-3 text-sm" role="status">{syncMsg}</p>}
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <div className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">Orders</dt><dd>{row(d.orders, "state")}</dd></div>
        <div className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">Tasks</dt><dd>{row(d.tasks, "state")}</dd></div>
        <div className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">Devices</dt><dd>{row(d.devices, "status")}</dd></div>
        <div className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">Rewards</dt><dd>{d.rewards.map((r: any) => `${r.state.toLowerCase()} ${usdc(r.units)}`).join(" · ") || "none"}</dd></div>
      </dl>
      <div className="mt-4">
        <div className="flex justify-between text-sm"><span>Unsettled contributor exposure</span><span className="font-mono">{usdc(d.exposure.unsettledUnits)} / {usdc(d.exposure.capUnits)}</span></div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-peach"><div className={`h-full ${exp > 0.8 ? "bg-bad" : "bg-charcoal"}`} style={{ width: `${Math.min(100, exp * 100)}%` }} /></div>
        <p className="mt-1 text-xs text-charcoal-60">New leases stop before the cap is exceeded.</p>
      </div>
      <div className={`mt-4 rounded-lg p-3 text-sm ${d.reconciliation.unbalancedJournals.length ? "bg-bad/10" : "bg-ok/10"}`}>
        <p className="font-bold">{d.reconciliation.unbalancedJournals.length ? "Ledger imbalance: stop settlement and investigate" : "Ledger balanced"}</p>
        <p className="mt-1 text-xs">Escrow per ledger {usdc(d.reconciliation.escrowLedgerUnits)} · on-chain {d.reconciliation.escrowOnChainUnits ? usdc(d.reconciliation.escrowOnChainUnits) : "n/a"}. {d.reconciliation.note}</p>
      </div>
      {d.openDisputes > 0 && <p className="mt-3 text-sm font-bold text-warn">{d.openDisputes} open dispute(s) need a decision.</p>}
    </Panel>
  );
}

function Settlements({ cfg }: { cfg: ApiConfig }) {
  const orders = useAsync(() => api<{ orders: any[] }>("/v1/admin/orders"));
  const st = useAsync(() => api<{ settlements: any[] }>("/v1/admin/settlements"));
  const [chunks, setChunks] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const reload = () => { orders.reload(); st.reload(); };
  const prepare = async (orderId: string) => {
    setMsg(null);
    try { const r = await api<{ chunks: any[] }>("/v1/admin/settlements/prepare", { json: { orderId } }); setChunks(r.chunks); reload(); } catch (e) { setMsg(errText(e)); }
  };
  const confirm = async (id: string, mock: boolean) => {
    setMsg(null);
    const txHash = mock ? undefined : prompt("Transaction hash of the executed Safe transaction")?.trim();
    if (!mock && !txHash) return;
    try { await api(`/v1/admin/settlements/${id}/confirm`, { json: mock ? { mock: true } : { txHash } }); setMsg("Settlement confirmed. Rewards are now claimable."); reload(); } catch (e) { setMsg(errText(e)); }
  };
  return (
    <Panel title="Settlement">
      <p className="text-sm text-charcoal-60">Orders with rewards past the review window can be settled in chunks of up to 100 recipients. Each chunk is executed from the 2-of-3 admin Safe; this page prepares the exact transaction data.</p>
      {msg && <p className="mt-3 text-sm" role="status">{msg}</p>}
      <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="text-charcoal-60"><tr><th className="py-1 font-normal">Order</th><th className="font-normal">Customer</th><th className="font-normal">State</th><th className="font-normal">Accepted</th><th className="font-normal">Settleable</th><th /></tr></thead>
        <tbody>{orders.data?.orders.map((o) => (
          <tr key={o.id} className="border-t border-line"><td className="py-2 font-mono text-xs">{short(o.id)}</td><td className="font-mono text-xs">{short(o.address)}</td><td><StatusBadge tone="idle">{o.state}</StatusBadge></td><td>{o.accepted_records}/{o.record_count}</td><td>{o.settleable}</td>
            <td className="text-right">{o.settleable > 0 && <Button variant="ghost" onClick={() => prepare(o.id)}>Prepare</Button>}</td></tr>
        ))}</tbody>
      </table></div>
      {chunks && chunks.map((c) => (
        <div key={c.settlementId} className="mt-4 rounded-lg border border-charcoal p-3 text-sm">
          <p className="font-bold">Chunk {short(c.settlementId)}: charge {usdc(c.charge)}, contributors {usdc(c.contributor)}, {c.recipients.length} recipient(s)</p>
          {c.safeTransaction ? (
            <div className="mt-2"><p className="text-xs">To <span className="font-mono">{c.safeTransaction.to}</span>, value 0. Data:</p>
              <textarea readOnly rows={3} className="mt-1 w-full rounded border border-line bg-white p-2 font-mono text-[11px]" value={c.safeTransaction.data} aria-label="Safe transaction data" />
              <Button variant="ghost" onClick={() => copyText(c.safeTransaction.data)}>Copy data</Button></div>
          ) : <p className="mt-2 text-xs">Escrow not deployed: confirm with simulated settlement.</p>}
        </div>
      ))}
      <h3 className="mt-6 font-bold">Settlements</h3>
      <ul className="mt-2 grid gap-2 text-sm">{st.data?.settlements.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2">
          <span className="font-mono text-xs">{short(s.id)} · order {short(s.order_id)}</span><span className="font-mono">{usdc(s.charge_units)}</span>
          <StatusBadge tone={s.status === "confirmed" ? "ok" : "warn"}>{s.status}</StatusBadge>
          {s.status === "proposed" && <span className="flex gap-2">{cfg.escrowAddress && <Button variant="ghost" onClick={() => confirm(s.id, false)}>Confirm with tx hash</Button>}{cfg.mockFunding && <Button variant="ghost" onClick={() => confirm(s.id, true)}>Confirm (simulated)</Button>}</span>}
          {s.tx_hash && <span className="font-mono text-[11px]">{short(s.tx_hash)}</span>}
        </li>
      ))}</ul>
    </Panel>
  );
}

function Disputes() {
  const d = useAsync(() => api<{ disputes: any[] }>("/v1/admin/disputes"));
  const resolve = async (id: string, outcome: "upheld" | "rejected") => {
    const resolution = prompt(`Resolution note (${outcome})`);
    if (!resolution) return;
    await api(`/v1/admin/disputes/${id}/resolve`, { json: { outcome, resolution } });
    d.reload();
  };
  return (
    <Panel title="Disputes and appeals">
      {d.data?.disputes.length === 0 && <p className="text-sm text-charcoal-60">None.</p>}
      <ul className="grid gap-2 text-sm">{d.data?.disputes.map((x) => (
        <li key={x.id} className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold">{x.kind === "customer_output" ? "Customer dispute" : "Contributor appeal"}</span><StatusBadge tone={x.status === "open" ? "warn" : "idle"}>{x.status}</StatusBadge></div>
          <p className="mt-1">{x.reason}</p>
          <p className="mt-1 font-mono text-[11px] text-charcoal-60">{short(x.address)} · {when(x.created_at)}{x.order_id ? ` · order ${short(x.order_id)}` : ""}</p>
          {x.status === "open" && <div className="mt-2 flex gap-2"><Button variant="ghost" onClick={() => resolve(x.id, "upheld")}>Uphold</Button><Button variant="ghost" onClick={() => resolve(x.id, "rejected")}>Reject</Button></div>}
        </li>
      ))}</ul>
    </Panel>
  );
}

function DevicesAdmin() {
  const d = useAsync(() => api<{ devices: any[] }>("/v1/admin/devices"));
  return (
    <Panel title="Devices">
      <ul className="grid gap-1 text-sm">{d.data?.devices.map((x) => (
        <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
          <span className="font-mono text-xs">{short(x.id)} · {short(x.address)}</span><span className="text-xs">{x.accepted_tasks}✓ {x.rejected_tasks}×</span>
          <select aria-label={`Status for ${x.id}`} value={x.status} disabled={x.status === "revoked"} className="min-h-9 rounded border border-line bg-white px-2 text-xs" onChange={async (e) => { await api(`/v1/admin/devices/${x.id}/status`, { json: { status: e.target.value } }); d.reload(); }}>
            {["probation", "active", "suspended", "revoked"].map((s) => <option key={s} value={s} disabled={s === "revoked"}>{s}</option>)}
          </select>
        </li>
      ))}</ul>
    </Panel>
  );
}

export default function AdminApp() {
  return (
    <AppGate need="admin">
      {(cfg) => (
        <div className="grid gap-6">
          <Overview />
          <Settlements cfg={cfg} />
          <div className="grid gap-6 lg:grid-cols-2"><Disputes /><DevicesAdmin /></div>
        </div>
      )}
    </AppGate>
  );
}
