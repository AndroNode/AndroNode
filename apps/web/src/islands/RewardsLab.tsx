import { useMemo, useState } from "react";
import { PRICING, PROBATION, ESCROW_TIMING } from "@andronode/protocol/params";
import { settleOrder, formatUnits } from "@andronode/protocol/money";
import { resetDemo, useDemo, type DemoState } from "../lib/demoStore";
import SimChip from "../components/SimChip";
import { Button, Field, Panel, Range, StatusBadge, type StatusTone } from "../components/ui";

const RATE = PRICING.illustrativeRatePer1kUnits;
const STAGES: { id: DemoState["rewardStage"]; label: string; tone: StatusTone; body: string }[] = [
  { id: "provisional", label: "Provisional reward", tone: "busy", body: "Recorded after acceptance. Not yet money you can move. Held for the proposed 48-hour customer review, then included in the next daily settlement. Capped at $1 per device while on probation." },
  { id: "claimable", label: "Claimable", tone: "ok", body: "Included in a settlement batch on the escrow contract (target: within 11 days of order start). You may withdraw it at any time." },
  { id: "withdrawn", label: "Withdrawn", tone: "idle", body: "You pulled the balance to your own wallet. The contract never pushes payments to you." },
];
const REFERENCE = [
  { title: "Fully completed", total: 10_000, accepted: 10_000 },
  { title: "90% accepted at deadline", total: 10_000, accepted: 9_000 },
];

export default function RewardsLab() {
  const [demo, setDemo] = useDemo();
  const [devices, setDevices] = useState(3);
  const [held, setHeld] = useState(false);
  const order = demo.order;
  const total = order?.recordIds.length ?? 200;
  const acceptedN = order?.acceptedRecordIds.length ?? 200;
  const s = useMemo(() => settleOrder(total, acceptedN, RATE), [total, acceptedN]);
  const perDevice = s.contributor / BigInt(devices);
  const dust = s.contributor - perDevice * BigInt(devices);
  const stageIdx = STAGES.findIndex((x) => x.id === demo.rewardStage);
  const capped = perDevice > PROBATION.deviceProvisionalCapUnits;

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel title={order ? "Your demo order" : "Example order"} chip={<SimChip kind="Illustrative" />}>
          {!order && <p className="mb-4 rounded-lg bg-peach-soft p-3 text-sm">No workload run yet, so this shows 200 accepted records. <a href="/workloads" className="font-bold underline">Run a workload</a> to use your own numbers.</p>}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {([["Records accepted", `${acceptedN.toLocaleString()} / ${total.toLocaleString()}`], ["Customer charged", `${formatUnits(s.charge)} USDC`], ["Contributors (75%)", `${formatUnits(s.contributor)} USDC`], ["Service (25%)", `${formatUnits(s.service)} USDC`], ["Refunded to customer", `${formatUnits(s.refund)} USDC`], ["Max funded", `${formatUnits(s.maxCharge)} USDC`]] as const).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">{k}</dt><dd className="font-mono tabular">{v}</dd></div>
            ))}
          </dl>
          <div className="mt-5">
            <Field label="Devices that did the accepted work" htmlFor="rw-dev" hint="Rewards follow accepted records, not uptime. An even split is shown for simplicity.">
              <Range id="rw-dev" value={devices} min={1} max={20} onChange={setDevices} />
            </Field>
            <p className="mt-2 text-sm">≈ <span className="font-mono font-bold">{formatUnits(perDevice)}</span> USDC per device{dust > 0n ? <> (+{formatUnits(dust)} assigned by record count)</> : null}.</p>
            {capped && <p className="mt-2 rounded-lg bg-warn/10 p-2 text-xs">Above the $1 probation cap per device. New devices stop receiving tasks at the cap until earlier rewards clear review.</p>}
          </div>
        </Panel>

        <Panel title="Reward lifecycle" chip={<SimChip />}>
          <ol className="grid gap-3">
            {STAGES.map((st, i) => (
              <li key={st.id} className={`rounded-lg border p-3 text-sm ${i === stageIdx && !held ? "border-charcoal bg-peach-soft" : "border-line"} ${i > stageIdx ? "opacity-60" : ""}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-bold">{i + 1}. {st.label}</span>{i === stageIdx && !held && <StatusBadge tone={st.tone}>Current</StatusBadge>}</div>
                <p className="mt-1 text-charcoal-80">{st.body}</p>
              </li>
            ))}
            {held && (
              <li className="rounded-lg border border-warn bg-warn/10 p-3 text-sm">
                <div className="flex items-center justify-between"><span className="font-bold">Held</span><StatusBadge tone="warn">Current</StatusBadge></div>
                <p className="mt-1">A dispute or abuse review is open. The amount is held, not deleted. You are told the reason code and can respond.</p>
              </li>
            )}
          </ol>
          <div className="mt-4 flex flex-wrap gap-2" aria-live="polite">
            {demo.rewardStage === "provisional" && !held && <Button variant="accent" onClick={() => setDemo({ rewardStage: "claimable" })}>Skip 48-hour review (demo)</Button>}
            {demo.rewardStage === "claimable" && !held && <Button variant="accent" onClick={() => setDemo({ rewardStage: "withdrawn" })}>Withdraw (demo)</Button>}
            {demo.rewardStage !== "withdrawn" && <Button variant="ghost" onClick={() => setHeld(!held)}>{held ? "Resolve dispute" : "Open a dispute"}</Button>}
            <Button variant="ghost" onClick={() => { resetDemo(); setHeld(false); }}>Reset demo</Button>
          </div>
          <p className="mt-3 text-xs text-charcoal-60">No wallet, transaction or real money is involved on this page.</p>
        </Panel>
      </div>

      <Panel title="Reference examples from the PRD" chip={<SimChip kind="Illustrative" />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-charcoal-60"><tr><th className="py-2 font-normal">Case</th><th className="font-normal">Accepted</th><th className="font-normal">Charged</th><th className="font-normal">Contributors</th><th className="font-normal">Service</th><th className="font-normal">Refund</th></tr></thead>
            <tbody>
              {REFERENCE.map((r) => {
                const x = settleOrder(r.total, r.accepted, RATE);
                return <tr key={r.title} className="border-t border-line font-mono tabular"><td className="py-2 font-sans">{r.title}</td><td>{r.accepted.toLocaleString()}</td><td>{formatUnits(x.charge)}</td><td>{formatUnits(x.contributor)}</td><td>{formatUnits(x.service)}</td><td>{formatUnits(x.refund)}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-charcoal-60">Amounts in USDC with 6 decimals. Per-record charges must divide by 4, so the 75/25 split never leaves rounding dust. Settlement pays at most {ESCROW_TIMING.maxRecipientsPerChunk} recipients per batch. There is no AndroNode token.</p>
      </Panel>
    </div>
  );
}
