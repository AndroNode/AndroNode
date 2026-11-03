import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { escrowAbi, erc20Abi, testUsdcAbi } from "@andronode/protocol/abi";
import { api, type ApiConfig } from "../../lib/api";
import { explorerTx, walletOnChain } from "../../lib/wallet";
import { download } from "../../lib/format";
import { Button, EmptyState, Field, Panel, Select, StatusBadge, type StatusTone } from "../../components/ui";
import AppGate, { errText, short, usdc, useAsync, when } from "./AppGate";

interface Quote { quote: { id: string; profileId: string; recordCount: number; maxChargeUnits: string; expiresAt: number }; funding: { escrow: string | null; asset: string; maxCharge: string; quoteHash: Hex; profileId: Hex; hardCloseAt: number; orderId: Hex } }
interface Order { id: string; state: string; funding_tx?: string | null; record_count: number; accepted_records: number; charged_units: number; funded_units: number; funding_mode: string; created_at: number; deadline_at: number | null; hard_close_at: number | null; finished_at: number | null }

const TONE: Record<string, StatusTone> = { QUOTED: "idle", FUNDED: "busy", RUNNING: "busy", COMPLETED: "ok", PARTIAL: "warn", CANCELLED: "idle", FAILED: "bad", CLOSED: "idle" };

function parseInput(mode: string, text: string, n: number): { id: string; text: string }[] {
  if (mode === "synthetic") return Array.from({ length: n }, (_, i) => ({ id: `syn-${String(i + 1).padStart(5, "0")}`, text: `Synthetic public sentence ${i + 1}: verified embedding work on everyday Android devices.` }));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.startsWith("{")) {
    return lines.map((l, i) => {
      const o = JSON.parse(l) as { id?: string; text?: string };
      return { id: String(o.id ?? `rec-${i + 1}`), text: String(o.text ?? "") };
    });
  }
  return lines.map((t, i) => ({ id: `rec-${String(i + 1).padStart(5, "0")}`, text: t }));
}

function NewOrder({ cfg, onCreated }: { cfg: ApiConfig; onCreated: () => void }) {
  const [mode, setMode] = useState("synthetic");
  const [n, setN] = useState(200);
  const [text, setText] = useState("");
  const [deadline, setDeadline] = useState("24");
  const [consent, setConsent] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ id: string; detail: string }[]>([]);
  const [tx, setTx] = useState<string | null>(null);
  const [nowMs, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const getQuote = async () => {
    setErr(null); setIssues([]); setQuote(null); setTx(null);
    try {
      const records = parseInput(mode, text, n);
      if (!records.length) throw new Error("Add at least one record");
      const { profiles } = await api<{ profiles: { id: string }[] }>("/v1/profiles", { auth: false });
      setStep("Validating records and pricing…");
      setQuote(await api<Quote>("/v1/quotes", { json: { profileId: profiles[0]!.id, records, deadlineHours: Number(deadline), acceptDataBoundary: consent } }));
    } catch (e: any) {
      setErr(errText(e));
      if (e?.detail?.issues) setIssues(e.detail.issues);
    } finally { setStep(null); }
  };

  const fundOnChain = async () => {
    if (!quote) return;
    setErr(null);
    try {
      const f = quote.funding;
      const { wallet, publicClient, address } = await walletOnChain(cfg);
      const max = BigInt(f.maxCharge);
      const bal = (await publicClient.readContract({ address: f.asset as Hex, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      if (bal < max) throw new Error(`Your wallet has ${usdc(bal)} test USDC; this order needs ${usdc(max)}. Use "Get test USDC" first.`);
      const allowance = (await publicClient.readContract({ address: f.asset as Hex, abi: erc20Abi, functionName: "allowance", args: [address, f.escrow as Hex] })) as bigint;
      if (allowance < max) {
        setStep("1/3 Approve test USDC in your wallet…");
        const h = await wallet.writeContract({ account: address, address: f.asset as Hex, abi: erc20Abi, functionName: "approve", args: [f.escrow as Hex, max] });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
      setStep("2/3 Fund the escrow in your wallet…");
      const hash = await wallet.writeContract({ account: address, address: f.escrow as Hex, abi: escrowAbi, functionName: "fundOrder", args: [max, f.quoteHash, f.profileId, BigInt(f.hardCloseAt)] });
      setTx(hash);
      setStep("3/3 Waiting for confirmations…");
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 3 });
      const r = await api<{ funding: { state: string; reason?: string; detail?: string } }>("/v1/orders", { json: { quoteId: quote.quote.id, fundingTxHash: hash } });
      if (r.funding.state !== "FUNDED") setErr(`Your payment is on-chain. The coordinator could not confirm it yet (${r.funding.reason}${r.funding.detail ? `: ${r.funding.detail}` : ""}) and keeps re-checking every few minutes. You can also open the order below and press Check funding.`);
      setQuote(null); onCreated();
    } catch (e) { setErr(errText(e)); } finally { setStep(null); }
  };

  const claimTestUsdc = async () => {
    const token = (quote?.funding.asset ?? cfg.settlementAsset.address) as Hex | null;
    if (!token) return;
    setErr(null); setStep("Claim 1,000 test USDC in your wallet…");
    try {
      const { wallet, publicClient, address } = await walletOnChain(cfg);
      const [last, cooldown] = await Promise.all([
        publicClient.readContract({ address: token, abi: testUsdcAbi, functionName: "lastClaim", args: [address] }),
        publicClient.readContract({ address: token, abi: testUsdcAbi, functionName: "FAUCET_COOLDOWN" }),
      ]);
      const block = await publicClient.getBlock();
      if (last > 0n && block.timestamp < last + cooldown) throw new Error(`You already claimed test USDC. The faucet opens again at ${new Date(Number(last + cooldown) * 1000).toLocaleString()}.`);
      const h = await wallet.writeContract({ account: address, address: token, abi: testUsdcAbi, functionName: "faucet" });
      setStep("Waiting for the faucet transaction…");
      await publicClient.waitForTransactionReceipt({ hash: h });
      const bal = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] })) as bigint;
      setErr(`Done. Your wallet now holds ${(Number(bal) / 1e6).toLocaleString("en-US")} test USDC.`);
    } catch (e) {
      setErr(errText(e));
    } finally { setStep(null); }
  };

  const fundMock = async () => {
    if (!quote) return;
    setErr(null); setStep("Creating order with simulated funding…");
    try {
      await api("/v1/orders", { json: { quoteId: quote.quote.id, mockFunding: true } });
      setQuote(null); onCreated();
    } catch (e) { setErr(errText(e)); } finally { setStep(null); }
  };

  const left = quote ? Math.max(0, Math.floor((quote.quote.expiresAt - nowMs) / 1000)) : 0;
  return (
    <Panel title="New embedding order">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-4">
          <Field label="Records" htmlFor="co-mode">
            <Select id="co-mode" value={mode} onChange={setMode} options={[{ value: "synthetic", label: "Synthetic test records" }, { value: "paste", label: "Paste text (one record per line, or JSONL)" }, { value: "file", label: "Upload .txt or .jsonl" }]} />
          </Field>
          {mode === "synthetic" && (
            <Field label="How many" htmlFor="co-n" hint="Up to 10,000 per order on testnet.">
              <input id="co-n" type="number" min={1} max={10000} value={n} onChange={(e) => setN(Math.max(1, Math.min(10000, Number(e.target.value) || 1)))} className="min-h-11 w-40 rounded-lg border border-charcoal/30 bg-white px-3" />
            </Field>
          )}
          {mode === "paste" && <textarea aria-label="Records" rows={6} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg border border-charcoal/30 bg-white p-3 text-sm" placeholder={'{"id":"doc-1","text":"First record"}\nor plain lines of text'} />}
          {mode === "file" && <input aria-label="Records file" type="file" accept=".txt,.jsonl,text/plain" className="text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />}
          <Field label="Execution deadline" htmlFor="co-dl">
            <Select id="co-dl" value={deadline} onChange={setDeadline} options={[{ value: "24", label: "24 hours" }, { value: "72", label: "3 days" }, { value: "168", label: "7 days (maximum)" }]} />
          </Field>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-[#27282D]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>These records are public, synthetic or cleared non-sensitive data, and I have the right to send them to third-party devices. Device owners can read what they process.</span></label>
          <Button variant="primary" disabled={!!step} onClick={getQuote}>Get quote</Button>
        </div>
        <div aria-live="polite">
          {quote ? (
            <div className="rounded-lg border border-charcoal p-4">
              <p className="font-mono text-xs text-charcoal-60">Quote {quote.quote.id} · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</p>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-charcoal-60">Records</dt><dd className="text-right font-mono">{quote.quote.recordCount}</dd>
                <dt className="text-charcoal-60">Maximum charge</dt><dd className="text-right font-mono font-bold">{usdc(quote.quote.maxChargeUnits)} USDC</dd>
                <dt className="text-charcoal-60">Rate</dt><dd className="text-right text-xs">{cfg.pricing.label}</dd>
              </dl>
              <p className="mt-2 text-xs text-charcoal-60">You pay only for accepted records. The rest is refundable after the order closes, or by you alone after the hard close date.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {quote.funding.escrow && <Button variant="accent" disabled={!!step || left === 0} onClick={fundOnChain}>Fund with test USDC</Button>}
                {quote.funding.escrow && cfg.settlementAsset.faucet && <Button variant="ghost" disabled={!!step} onClick={claimTestUsdc}>Get test USDC</Button>}
                {cfg.mockFunding && <Button variant={quote.funding.escrow ? "ghost" : "accent"} disabled={!!step || left === 0} onClick={fundMock}>Use simulated funding</Button>}
              </div>
              {left === 0 && <p className="mt-2 text-sm text-bad">Quote expired. Get a new one.</p>}
            </div>
          ) : (
            <EmptyState title="No quote yet" body="Choose records, confirm the data boundary and request a quote. Quotes last 15 minutes." />
          )}
          {step && <p className="mt-3 text-sm">{step}</p>}
          {tx && <a className="mt-2 block text-sm underline" href={explorerTx(cfg, tx)} target="_blank" rel="noopener noreferrer">View funding transaction</a>}
          {err && <p role="alert" className="mt-3 text-sm text-bad">{err}</p>}
          {issues.length > 0 && <ul className="mt-2 max-h-40 overflow-auto font-mono text-xs">{issues.slice(0, 50).map((i, k) => <li key={k}>{i.id}: {i.detail}</li>)}</ul>}
        </div>
      </div>
    </Panel>
  );
}

function OrderDetail({ cfg, id, onChange }: { cfg: ApiConfig; id: string; onChange: () => void }) {
  const d = useAsync(() => api<any>(`/v1/orders/${id}`), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!d.data || !["FUNDED", "RUNNING"].includes(d.data.order.state)) return;
    const t = setTimeout(d.reload, 4000);
    return () => clearTimeout(t);
  }, [d.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (d.error) return <p className="text-sm text-bad">{d.error}</p>;
  if (!d.data) return <p className="text-sm text-charcoal-60">Loading order…</p>;
  const o = d.data.order as Order;
  const act = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); setMsg(ok); d.reload(); onChange(); } catch (e) { setMsg(errText(e)); } };
  const results = async () => {
    const r = await api<{ tasks: { idx: number; download: string | null }[] }>(`/v1/orders/${o.id}/results`);
    const lines: string[] = [];
    for (const t of r.tasks.filter((x) => x.download)) {
      const part = await api<{ results: { id: string; vector: number[] }[]; receiptId: string; profileId: string }>(t.download!);
      for (const x of part.results) lines.push(JSON.stringify({ id: x.id, vector: x.vector, receipt: part.receiptId, profile: part.profileId, status: "ACCEPTED" }));
    }
    download(`andronode-${o.id.slice(0, 10)}.jsonl`, lines.join("\n"), "application/x-ndjson");
  };
  const refund = async () => {
    const { wallet, publicClient, address } = await walletOnChain(cfg);
    const h = await wallet.writeContract({ account: address, address: cfg.escrowAddress as Hex, abi: escrowAbi, functionName: "refundRemainder", args: [o.id as Hex] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  };
  const checkFunding = async () => {
    const typed = (document.getElementById(`tx-${o.id}`) as HTMLInputElement | null)?.value.trim();
    const r = await api<{ funding: { state: string; reason?: string; detail?: string } }>(`/v1/orders/${o.id}/check-funding`, { json: typed ? { fundingTxHash: typed } : {} });
    if (r.funding.state !== "FUNDED") throw new Error(`Not confirmed yet: ${r.funding.reason}${r.funding.detail ? ` (${r.funding.detail})` : ""}. Try again in a minute.`);
  };
  const canRefund = cfg.escrowAddress && o.funding_mode === "chain" && (o.state === "CLOSED" || (o.hard_close_at && Date.now() > o.hard_close_at));
  return (
    <div className="mt-4 rounded-lg border border-line p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs">{o.id}</span>
        <StatusBadge tone={TONE[o.state] ?? "idle"}>{o.state}</StatusBadge>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-peach"><div className="h-full bg-charcoal" style={{ width: `${(o.accepted_records / o.record_count) * 100}%` }} /></div>
      <dl className="mt-3 grid gap-2 sm:grid-cols-4">
        <div><dt className="text-charcoal-60">Accepted</dt><dd className="font-mono">{o.accepted_records} / {o.record_count}</dd></div>
        <div><dt className="text-charcoal-60">Charged</dt><dd className="font-mono">{usdc(o.charged_units)}</dd></div>
        <div><dt className="text-charcoal-60">In flight (still payable)</dt><dd className="font-mono">{usdc(d.data.outstandingLiabilityUnits)}</dd></div>
        <div><dt className="text-charcoal-60">Refundable estimate</dt><dd className="font-mono">{usdc(d.data.refundableEstimateUnits)}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-charcoal-60">Tasks: {d.data.tasks.map((t: any) => `${t.state.toLowerCase()} ${t.n}`).join(" · ") || "none"}. Deadline {when(o.deadline_at)}. Hard close {when(o.hard_close_at)}.</p>
      {d.data.receipts.some((r: any) => r.decision === "REJECTED") && <p className="mt-1 text-xs">Rejected attempts (not charged, retried elsewhere): {d.data.receipts.filter((r: any) => r.decision === "REJECTED").map((r: any) => `${r.reason} ×${r.n}`).join(", ")}</p>}
      {o.state === "QUOTED" && o.funding_mode === "chain" && cfg.escrowAddress && (
        <div className="mt-4 rounded-lg bg-peach-soft p-3">
          <p className="text-sm">Waiting for on-chain funding. If you already paid, check it now. The coordinator also re-checks automatically.</p>
          <label className="mt-2 block text-xs text-charcoal-60" htmlFor={`tx-${o.id}`}>Funding transaction hash</label>
          <input id={`tx-${o.id}`} defaultValue={o.funding_tx ?? ""} placeholder="0x…" spellCheck={false} className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs" />
          <div className="mt-2"><Button variant="accent" onClick={() => act(checkFunding, "Funding confirmed. Work starts now.")}>Check funding</Button></div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {o.accepted_records > 0 && <Button variant="ghost" onClick={() => act(results, "Download started")}>Download results (JSONL)</Button>}
        {["FUNDED", "RUNNING"].includes(o.state) && <Button variant="ghost" onClick={() => act(() => api(`/v1/orders/${o.id}/cancel`, { method: "POST" }), "Cancelled. Already-leased work may still finish and be charged.")}>Cancel order</Button>}
        {o.accepted_records > 0 && <Button variant="ghost" onClick={() => { const reason = prompt("Describe the problem with the results (at least 10 characters)"); if (reason) act(() => api(`/v1/orders/${o.id}/disputes`, { json: { reason } }), "Dispute opened. Affected contributor rewards are on hold."); }}>Open dispute</Button>}
        {canRefund && <Button variant="accent" onClick={() => act(refund, "Refund sent to your wallet")}>Refund unspent USDC</Button>}
      </div>
      {msg && <p className="mt-2 text-sm" role="status">{msg}</p>}
    </div>
  );
}

function ApiKeys() {
  const keys = useAsync(() => api<{ keys: any[] }>("/v1/api-keys"));
  const [fresh, setFresh] = useState<string | null>(null);
  return (
    <Panel title="API keys">
      <p className="text-sm text-charcoal-60">For scripts using the batch API. Keys can quote and create orders but never act as admin.</p>
      <div className="mt-3 flex gap-2"><Button variant="ghost" onClick={async () => { const r = await api<{ key: string }>("/v1/api-keys", { json: { label: "dashboard" } }); setFresh(r.key); keys.reload(); }}>Create key</Button></div>
      {fresh && <p className="mt-3 break-all rounded-lg bg-peach-soft p-3 font-mono text-xs">{fresh}<span className="mt-1 block font-sans">Shown once. Copy it now.</span></p>}
      <ul className="mt-3 grid gap-1 text-sm">
        {keys.data?.keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between gap-2"><span className="font-mono text-xs">{k.prefix}… {k.label}</span>{k.revoked_at ? <span className="text-xs text-charcoal-60">revoked</span> : <button type="button" className="min-h-9 text-xs underline" onClick={async () => { await api(`/v1/api-keys/${k.id}`, { method: "DELETE" }); keys.reload(); }}>Revoke</button>}</li>
        ))}
      </ul>
    </Panel>
  );
}

function Orders({ cfg }: { cfg: ApiConfig }) {
  const list = useAsync(() => api<{ orders: Order[] }>("/v1/orders"));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid gap-6">
      <NewOrder cfg={cfg} onCreated={list.reload} />
      <Panel title="Your orders" actions={<button type="button" className="min-h-9 text-xs underline" onClick={list.reload}>Refresh</button>}>
        {list.error && <p className="text-sm text-bad">{list.error}</p>}
        {list.data && list.data.orders.length === 0 && <EmptyState title="No orders yet" body="Create one above. Simulated funding is available while the escrow is not deployed." />}
        <ul className="grid gap-2">
          {list.data?.orders.map((o) => (
            <li key={o.id}>
              <button type="button" aria-expanded={open === o.id} onClick={() => setOpen(open === o.id ? null : o.id)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-charcoal/40">
                <span className="font-mono text-xs">{short(o.id)}</span>
                <span>{o.accepted_records}/{o.record_count} records</span>
                <span className="font-mono text-xs">{usdc(o.charged_units)} / {usdc(o.funded_units)}</span>
                <StatusBadge tone={TONE[o.state] ?? "idle"}>{o.state}</StatusBadge>
              </button>
              {open === o.id && <OrderDetail cfg={cfg} id={o.id} onChange={list.reload} />}
            </li>
          ))}
        </ul>
      </Panel>
      <ApiKeys />
    </div>
  );
}

export default function CustomerApp() {
  return <AppGate>{(cfg) => <Orders cfg={cfg} />}</AppGate>;
}
