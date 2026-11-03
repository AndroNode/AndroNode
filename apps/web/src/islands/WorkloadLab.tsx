import { useEffect, useMemo, useState } from "react";
import { DEMO_PROFILE, OVER_LIMIT_RECORD, SAMPLE_RECORDS, WORKLOAD_SCENARIOS, authoredVector, type FixtureRecord, type WorkloadScenario } from "@andronode/fixtures";
import { PRICING } from "@andronode/protocol/params";
import { perRecordCharge, settleOrder, allocate, formatUnits } from "@andronode/protocol/money";
import { planTasks, validateRecords, type TaskPlan } from "@andronode/protocol/tasks";
import type { TaskState } from "@andronode/protocol/states";
import { useDemo } from "../lib/demoStore";
import { useMotion } from "../lib/motion";
import { download } from "../lib/format";
import SimChip from "../components/SimChip";
import { Button, EmptyState, Field, Panel, Select, StatusBadge, Toggle, type StatusTone } from "../components/ui";

const PER_RECORD = perRecordCharge(PRICING.illustrativeRatePer1kUnits);
type Source = "sample" | "batch" | "custom";

function batchRecords(n: number): FixtureRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const s = SAMPLE_RECORDS[i % SAMPLE_RECORDS.length]!;
    return { id: `rec-${String(i + 1).padStart(3, "0")}`, text: s.text, tokens: s.tokens };
  });
}
const estTokens = (t: string) => Math.ceil(t.trim().split(/\s+/).filter(Boolean).length * 1.3) + 2;

interface Ev { task: number; state: TaskState; note: string }

/** Builds a deterministic event script for a scenario (PRD FR-11). */
function script(tasks: TaskPlan[], scenario: WorkloadScenario): { events: Ev[]; outcome: "COMPLETED" | "PARTIAL" | "CANCELLED" } {
  const ev: Ev[] = [];
  const lastIdx = tasks.length - 1;
  const run = (i: number, verifyNote = "Verifier recomputing reference vectors") => {
    ev.push({ task: i, state: "LEASED", note: `Task ${i + 1} leased to a device (lease ≤ 120 s)` });
    ev.push({ task: i, state: "SUBMITTED", note: `Task ${i + 1} submitted before lease expiry` });
    ev.push({ task: i, state: "VERIFYING", note: verifyNote });
    ev.push({ task: i, state: "ACCEPTED", note: `Task ${i + 1} accepted: ${tasks[i]!.recordIds.length} records` });
  };
  switch (scenario) {
    case "complete":
      tasks.forEach((_, i) => run(i));
      return { events: ev, outcome: "COMPLETED" };
    case "partial": {
      const unfinished = Math.max(1, Math.floor(tasks.length / 3));
      tasks.slice(0, tasks.length - unfinished).forEach((_, i) => run(i));
      for (let i = tasks.length - unfinished; i <= lastIdx; i++) {
        if (i === tasks.length - unfinished) ev.push({ task: i, state: "LEASED", note: `Task ${i + 1} leased, but the device disconnected` }, { task: i, state: "EXPIRED", note: `Task ${i + 1} lease expired with no submission` });
      }
      ev.push({ task: -1, state: "FAILED", note: "Order deadline reached. Unfinished records are not charged." });
      for (let i = tasks.length - unfinished; i <= lastIdx; i++) ev.push({ task: i, state: "FAILED", note: `Task ${i + 1} closed unfinished` });
      return { events: ev, outcome: "PARTIAL" };
    }
    case "rejected": {
      const bad = Math.min(1, lastIdx);
      tasks.forEach((_, i) => {
        if (i !== bad) return run(i);
        ev.push({ task: i, state: "LEASED", note: `Task ${i + 1} leased to device A` });
        ev.push({ task: i, state: "SUBMITTED", note: `Task ${i + 1} submitted by device A` });
        ev.push({ task: i, state: "VERIFYING", note: "Verifier recomputing reference vectors" });
        ev.push({ task: i, state: "REJECTED", note: "Rejected: NUMERIC_MISMATCH. No reward for this attempt; no charge to the customer." });
        ev.push({ task: i, state: "QUEUED", note: `Task ${i + 1} re-queued for a different device` });
        run(i, "Retry from device B is being verified");
      });
      return { events: ev, outcome: "COMPLETED" };
    }
    case "cancelled": {
      run(0);
      if (lastIdx >= 1) {
        ev.push({ task: 1, state: "LEASED", note: "Task 2 leased" });
        ev.push({ task: -1, state: "CANCELLED", note: "Customer cancelled. No new leases will be issued." });
        ev.push({ task: 1, state: "SUBMITTED", note: "Task 2 was already leased, so it may still finish" });
        ev.push({ task: 1, state: "VERIFYING", note: "Verifier checking task 2" });
        ev.push({ task: 1, state: "ACCEPTED", note: "Task 2 accepted and payable" });
        for (let i = 2; i <= lastIdx; i++) ev.push({ task: i, state: "CANCELLED", note: `Task ${i + 1} cancelled before lease` });
      }
      return { events: ev, outcome: lastIdx >= 1 ? "CANCELLED" : "COMPLETED" };
    }
    case "verifier-delayed":
      tasks.forEach((_, i) => {
        ev.push({ task: i, state: "LEASED", note: `Task ${i + 1} leased` });
        ev.push({ task: i, state: "SUBMITTED", note: `Task ${i + 1} submitted on time` });
        ev.push({ task: i, state: "VERIFYING", note: `Task ${i + 1} waiting in verifier backlog` });
      });
      ev.push({ task: -1, state: "VERIFYING", note: "Backlog: submissions stay in Verifying. Their leases cannot expire now." });
      tasks.forEach((t, i) => ev.push({ task: i, state: "ACCEPTED", note: `Task ${i + 1} accepted after delay (${t.recordIds.length} records)` }));
      return { events: ev, outcome: "COMPLETED" };
  }
}

const TONE: Partial<Record<TaskState, StatusTone>> = { QUEUED: "idle", LEASED: "busy", SUBMITTED: "busy", VERIFYING: "busy", ACCEPTED: "ok", REJECTED: "bad", EXPIRED: "warn", FAILED: "warn", CANCELLED: "idle" };

export default function WorkloadLab() {
  const [demo, setDemo] = useDemo();
  const motion = useMotion();
  const [source, setSource] = useState<Source>("batch");
  const [includeLong, setIncludeLong] = useState(false);
  const [custom, setCustom] = useState("");
  const [scenario, setScenario] = useState<WorkloadScenario>("complete");
  const [stage, setStage] = useState<"build" | "quote" | "run" | "done">("build");
  const [cursor, setCursor] = useState(0);

  const records: FixtureRecord[] = useMemo(() => {
    let base: FixtureRecord[] =
      source === "sample" ? SAMPLE_RECORDS : source === "batch" ? batchRecords(200)
      : custom.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 500).map((text, i) => ({ id: `c-${String(i + 1).padStart(3, "0")}`, text, tokens: estTokens(text) }));
    if (includeLong) base = [...base, OVER_LIMIT_RECORD];
    return base;
  }, [source, includeLong, custom]);

  const issues = useMemo(() => validateRecords(records), [records]);
  const tasks = useMemo(() => (issues.length ? [] : planTasks(records, PER_RECORD)), [records, issues]);
  const maxCharge = PER_RECORD * BigInt(records.length);
  const plan = useMemo(() => (tasks.length ? script(tasks, scenario) : null), [tasks, scenario]);
  const profileOk = demo.profileId === DEMO_PROFILE.id;

  // Replay the script one event at a time; with motion off, the user steps manually.
  useEffect(() => {
    if (stage !== "run" || !plan || !motion) return;
    if (cursor >= plan.events.length) return;
    const t = setTimeout(() => setCursor((c) => c + 1), 450);
    return () => clearTimeout(t);
  }, [stage, cursor, plan, motion]);

  const taskStates: TaskState[] = useMemo(() => {
    const s: TaskState[] = tasks.map(() => "QUEUED");
    plan?.events.slice(0, cursor).forEach((e) => { if (e.task >= 0) s[e.task] = e.state; });
    return s;
  }, [tasks, plan, cursor]);

  const finished = !!plan && cursor >= plan.events.length;
  const accepted = tasks.filter((_, i) => taskStates[i] === "ACCEPTED");
  const acceptedRecordIds = accepted.flatMap((t) => t.recordIds);
  const settlement = settleOrder(records.length, finished ? acceptedRecordIds.length : 0, PRICING.illustrativeRatePer1kUnits);

  useEffect(() => {
    if (!finished || stage !== "run" || !plan) return;
    setStage("done");
    setDemo({
      order: {
        orderId: "demo-ord-" + Date.now().toString(36),
        recordIds: records.map((r) => r.id),
        scenario,
        acceptedRecordIds,
        receiptIds: accepted.map((t) => `demo-rcpt-t${String(t.index + 1).padStart(3, "0")}`),
        rejected: plan.events.filter((e) => e.state === "REJECTED").map((e) => ({ taskId: `task-${e.task + 1}`, reason: "NUMERIC_MISMATCH" })),
        finished: true,
      },
      rewardStage: "provisional",
    });
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => { setCursor(0); setStage("run"); };
  const restart = () => { setCursor(0); setStage("build"); };
  const exportResults = () => {
    const out = { notice: "Authored demo vectors. Not model output. Do not use for any purpose.", profileId: DEMO_PROFILE.id, orderId: demo.order?.orderId, results: acceptedRecordIds.slice(0, 64).map((id) => ({ id, vector: authoredVector(id) })), truncated: acceptedRecordIds.length > 64 };
    download("andronode-demo-results.json", JSON.stringify(out, null, 1));
  };

  return (
    <div className="grid gap-6">
      {!profileOk && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-orange/40 bg-peach-soft p-4 text-sm">
          <span>No model profile selected. The demo will use the candidate embedding profile.</span>
          <Button variant="ghost" onClick={() => setDemo({ profileId: DEMO_PROFILE.id })}>Select it</Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="1. Records" chip={<SimChip />}>
          <fieldset disabled={stage === "run"} className="grid gap-4">
            <Field label="Input" htmlFor="wl-src">
              <Select id="wl-src" value={source} onChange={(v) => { setSource(v as Source); restart(); }} options={[{ value: "batch", label: "Synthetic batch (200 records)" }, { value: "sample", label: "Sample sentences (24 records)" }, { value: "custom", label: "Paste my own text" }]} />
            </Field>
            {source === "custom" && (
              <Field label="One record per line (max 500 lines)" htmlFor="wl-custom" hint="Stays in your browser. Do not paste personal or confidential text; real customers must have rights to their data.">
                <textarea id="wl-custom" rows={6} value={custom} onChange={(e) => { setCustom(e.target.value); restart(); }} className="w-full rounded-lg border border-charcoal/30 bg-white p-3 text-sm" placeholder={"The device stops when the battery drops.\nVerification compares vectors with a reference."} />
              </Field>
            )}
            <Toggle id="wl-long" label="Add a 312-token record (over the limit)" checked={includeLong} onChange={(v) => { setIncludeLong(v); restart(); }} />
          </fieldset>
          <div className="mt-4 text-sm" aria-live="polite">
            {records.length === 0 ? (
              <EmptyState title="No records yet" body="Paste at least one line, or choose a sample set." />
            ) : issues.length ? (
              <div className="rounded-lg border border-bad/40 bg-bad/5 p-3">
                <p className="font-bold text-bad">{issues.length} problem{issues.length > 1 ? "s" : ""} to fix before a quote</p>
                <ul className="mt-2 grid gap-1 font-mono text-xs">{issues.slice(0, 6).map((i, k) => <li key={k}>{i.id}: {i.detail}</li>)}</ul>
                <p className="mt-2 text-xs">Long records are rejected, never silently truncated.</p>
              </div>
            ) : (
              <p><span className="font-bold">{records.length}</span> valid records → <span className="font-bold">{tasks.length}</span> task{tasks.length > 1 ? "s" : ""} of up to 64 records.</p>
            )}
          </div>
        </Panel>

        <Panel title="2. Quote" chip={<SimChip kind="Illustrative" />}>
          {tasks.length === 0 ? (
            <p className="text-sm text-charcoal-60">A quote appears once the records are valid.</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-charcoal-60">Rate</dt><dd className="text-right font-mono">$0.20 / 1,000 records</dd>
                <dt className="text-charcoal-60">Per record</dt><dd className="text-right font-mono">{formatUnits(PER_RECORD)} USDC</dd>
                <dt className="text-charcoal-60">Maximum charge</dt><dd className="text-right font-mono font-bold">{formatUnits(maxCharge)} USDC</dd>
                <dt className="text-charcoal-60">Contributors (75%)</dt><dd className="text-right font-mono">{formatUnits(allocate(maxCharge).contributor)}</dd>
                <dt className="text-charcoal-60">Service (25%)</dt><dd className="text-right font-mono">{formatUnits(allocate(maxCharge).service)}</dd>
              </dl>
              <p className="mt-3 text-xs text-charcoal-60">You fund the maximum into escrow and pay only for accepted records. The rest is refunded. Illustrative pilot rate, not a price offer.</p>
              <Field label="What happens during the run" htmlFor="wl-scn">
                <Select id="wl-scn" value={scenario} onChange={(v) => { setScenario(v as WorkloadScenario); if (stage !== "run") setStage("build"); }} options={WORKLOAD_SCENARIOS.map((s) => ({ value: s.id, label: s.title }))} />
              </Field>
              <p className="mt-2 text-sm">{WORKLOAD_SCENARIOS.find((s) => s.id === scenario)!.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="accent" disabled={stage === "run"} onClick={start}>{stage === "done" ? "Run again" : "Fund demo escrow and run"}</Button>
              </div>
            </>
          )}
        </Panel>
      </div>

      {(stage === "run" || stage === "done") && plan && (
        <Panel title="3. Run" chip={<SimChip />} actions={<span className="font-mono text-[11px] text-charcoal-60">Accelerated</span>}>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Tasks">
            {tasks.map((t, i) => (
              <li key={t.index} className="flex items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
                <span>Task {i + 1} <span className="font-mono text-xs text-charcoal-60">· {t.recordIds.length} rec</span></span>
                <StatusBadge tone={TONE[taskStates[i]!] ?? "idle"}>{taskStates[i]!.charAt(0) + taskStates[i]!.slice(1).toLowerCase()}</StatusBadge>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!finished && !motion && <Button variant="ghost" onClick={() => setCursor((c) => c + 1)}>Next event</Button>}
            {!finished && <Button variant="ghost" onClick={() => setCursor(plan.events.length)}>Skip to end</Button>}
            <span className="font-mono text-xs text-charcoal-60">{Math.min(cursor, plan.events.length)} / {plan.events.length} events</span>
          </div>
          <ol className="mt-3 max-h-56 overflow-auto rounded-lg bg-charcoal/[0.03] p-3 font-mono text-xs" aria-live="polite">
            {cursor === 0 ? <li>Escrow funded with {formatUnits(maxCharge)} demo USDC. Tasks queued.</li> : plan.events.slice(0, cursor).map((e, i) => <li key={i}>{e.note}</li>).reverse()}
          </ol>
        </Panel>
      )}

      {stage === "done" && plan && (
        <Panel title="4. Result" chip={<SimChip />}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={plan.outcome === "COMPLETED" ? "ok" : "warn"}>{plan.outcome === "COMPLETED" ? "Completed" : plan.outcome === "PARTIAL" ? "Partial" : "Cancelled"}</StatusBadge>
            <span className="text-sm">{acceptedRecordIds.length} of {records.length} records accepted</span>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
            {([["Charged", settlement.charge], ["Contributors", settlement.contributor], ["Service", settlement.service], ["Refund to you", settlement.refund]] as const).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line p-3"><dt className="text-charcoal-60">{k}</dt><dd className="font-mono text-lg tabular">{formatUnits(v)}</dd></div>
            ))}
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={exportResults} disabled={!acceptedRecordIds.length}>Download demo results (JSON)</Button>
            <a href="/verify" className="inline-flex min-h-11 items-center rounded-full bg-charcoal px-4 text-sm font-bold text-paper">Inspect receipts →</a>
            <a href="/rewards" className="inline-flex min-h-11 items-center rounded-full border border-charcoal/30 px-4 text-sm font-bold">See rewards →</a>
          </div>
          <p className="mt-3 text-xs text-charcoal-60">Downloaded vectors are authored for this demo, not model output.</p>
        </Panel>
      )}
    </div>
  );
}
