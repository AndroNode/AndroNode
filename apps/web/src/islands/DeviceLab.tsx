import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { evaluateDevice, sessionGate, type NetworkKind, type ThermalStatus } from "@andronode/protocol/eligibility";
import { SESSION_DEFAULTS } from "@andronode/protocol/params";
import { allocate, perRecordCharge, formatUnits } from "@andronode/protocol/money";
import { PRICING } from "@andronode/protocol/params";
import { DEVICE_PRESETS, type DevicePreset } from "@andronode/fixtures";
import SimChip from "../components/SimChip";
import Companion from "../components/Companion";
import { Button, EmptyState, ErrorState, Field, Panel, Range, Select, StatusBadge, Toggle, type StatusTone } from "../components/ui";

/** Demo time runs 10x faster than real time; every timeline is labelled as accelerated (PRD AC-09.b, AC-11.b). */
const SPEED = 10;
const TICK_MS = 250;
const DEMO_SEC_PER_TICK = (TICK_MS / 1000) * SPEED;
const TASK_DEMO_SEC = 20;
const VERIFY_DEMO_SEC = 10;
const REWARD = allocate(perRecordCharge(PRICING.illustrativeRatePer1kUnits) * 64n).contributor;
const GiB = 1024 ** 3;

type Phase = "idle" | "waiting" | "working" | "verifying" | "paused" | "stopped" | "ended";

interface Sim {
  phase: Phase;
  pauseReason: string | null;
  elapsed: number; // demo seconds into session
  queue: number; // sample tasks waiting
  taskProgress: number; // demo seconds into current task
  verifyLeft: number;
  accepted: number;
  thermalStableFor: number; // demo seconds of acceptable thermal state since last severe
  hadThermalPause: boolean;
  dataUsed: number;
  log: { t: number; msg: string }[];
}

const initialSim: Sim = { phase: "idle", pauseReason: null, elapsed: 0, queue: 0, taskProgress: 0, verifyLeft: 0, accepted: 0, thermalStableFor: 0, hadThermalPause: false, dataUsed: 0, log: [] };

interface Cond {
  externalPower: boolean;
  battery: number;
  network: NetworkKind;
  thermal: ThermalStatus;
  dataBudgetGiB: number;
  dataUsedGiB: number;
  minutes: number;
}

type Action =
  | { type: "start" }
  | { type: "stop" }
  | { type: "pauseOwner" }
  | { type: "resume" }
  | { type: "load" }
  | { type: "reset" }
  | { type: "tick"; cond: Cond; hasBattery: boolean };

const log = (s: Sim, msg: string): Sim["log"] => [{ t: s.elapsed, msg }, ...s.log].slice(0, 40);

function reducer(s: Sim, a: Action): Sim {
  switch (a.type) {
    case "reset":
      return initialSim;
    case "start":
      return { ...initialSim, queue: s.queue, accepted: s.accepted, phase: s.queue > 0 ? "working" : "waiting", log: log(s, "Session started by owner") };
    case "stop":
      return { ...s, phase: "stopped", taskProgress: 0, pauseReason: null, log: log(s, s.phase === "working" ? "Stopped by owner. Active task returned unfinished; no partial reward, no penalty." : "Stopped by owner") };
    case "pauseOwner":
      return { ...s, phase: "paused", pauseReason: "Paused by owner", taskProgress: 0, log: log(s, "Paused by owner. Active task returned.") };
    case "resume":
      return { ...s, phase: s.queue > 0 ? "working" : "waiting", pauseReason: null, log: log(s, "Resumed by owner") };
    case "load":
      return { ...s, queue: s.queue + 3, phase: s.phase === "waiting" ? "working" : s.phase, log: log(s, "Sample job loaded: 3 tasks of 64 records") };
    case "tick": {
      if (s.phase === "idle" || s.phase === "stopped" || s.phase === "ended") return s;
      if (s.pauseReason === "Paused by owner") return s;
      let n: Sim = { ...s, elapsed: s.elapsed + DEMO_SEC_PER_TICK };
      const limit = a.cond.minutes * 60;
      if (n.elapsed >= limit) {
        return { ...n, phase: "ended", taskProgress: 0, log: log(n, "Session time reached. No new tasks; resources released.") };
      }
      const gate = sessionGate({
        externalPower: a.cond.externalPower,
        batteryPercent: a.hasBattery ? a.cond.battery : null,
        network: a.cond.network,
        thermal: a.cond.thermal,
        dataUsedBytes: (a.cond.dataUsedGiB) * GiB,
        dataBudgetBytes: a.cond.dataBudgetGiB * GiB,
        ownerStopped: false,
        working: n.phase === "working" || n.phase === "verifying" || (n.phase === "paused" && n.pauseReason?.startsWith("Battery") === false),
      });
      // Thermal recovery: after a temperature pause, wait 5 stable minutes (§5.2).
      const severe = a.cond.thermal === "severe" || a.cond.thermal === "critical";
      if (severe) n = { ...n, hadThermalPause: true, thermalStableFor: 0 };
      else if (n.hadThermalPause) n = { ...n, thermalStableFor: n.thermalStableFor + DEMO_SEC_PER_TICK };
      const recovering = n.hadThermalPause && !severe && n.thermalStableFor < SESSION_DEFAULTS.thermalRecoveryStableMs / 1000;

      if (gate.kind === "pause" || recovering) {
        const reason = recovering ? "Cooling down: waiting for 5 stable minutes" : gate.kind === "pause" ? gate.reason : "";
        if (n.phase !== "paused" || n.pauseReason !== reason) {
          return { ...n, phase: "paused", pauseReason: reason, taskProgress: 0, log: log(n, `${reason}. New assignments halted${n.phase === "working" ? "; active task returned" : ""}.`) };
        }
        return n;
      }
      if (n.hadThermalPause && !recovering) n = { ...n, hadThermalPause: false, thermalStableFor: 0, log: log(n, "Temperature stable for 5 minutes. Work may resume.") };
      if (n.phase === "paused") n = { ...n, phase: n.queue > 0 ? "working" : "waiting", pauseReason: null, log: log(n, "Conditions OK again. Resuming.") };

      if (n.phase === "waiting" && n.queue > 0) n = { ...n, phase: "working" };
      if (n.phase === "working") {
        const rate = gate.kind === "run" && gate.reducedLoad ? 0.5 : 1;
        const p = n.taskProgress + DEMO_SEC_PER_TICK * rate;
        if (p >= TASK_DEMO_SEC) {
          return { ...n, phase: "verifying", taskProgress: 0, verifyLeft: VERIFY_DEMO_SEC, queue: n.queue - 1, log: log(n, "Task submitted before lease expiry. Waiting for verification.") };
        }
        return { ...n, taskProgress: p };
      }
      if (n.phase === "verifying") {
        const left = n.verifyLeft - DEMO_SEC_PER_TICK;
        if (left <= 0) {
          const next: Sim = { ...n, verifyLeft: 0, accepted: n.accepted + 1, log: log(n, `Task accepted. Provisional reward ${formatUnits(REWARD)} USDC (illustrative).`) };
          return { ...next, phase: next.queue > 0 ? "working" : "waiting" };
        }
        return { ...n, verifyLeft: left };
      }
      return n;
    }
  }
}

function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function DeviceLab() {
  const [presetId, setPresetId] = useState(DEVICE_PRESETS[0]!.id);
  const [corrupt, setCorrupt] = useState(false);
  const preset = DEVICE_PRESETS.find((p) => p.id === presetId) as DevicePreset;
  const [cond, setCond] = useState<Cond>({ externalPower: true, battery: preset.defaultBatteryPercent ?? 100, network: "unmetered", thermal: "none", dataBudgetGiB: 1, dataUsedGiB: 0.1, minutes: SESSION_DEFAULTS.defaultMinutes });
  const [sim, dispatch] = useReducer(reducer, initialSim);
  const [evaluating, setEvaluating] = useState(false);
  const [blink, setBlink] = useState(0);
  const condRef = useRef(cond);
  condRef.current = cond;

  const elig = useMemo(() => evaluateDevice(preset), [preset]);
  const running = sim.phase !== "idle" && sim.phase !== "stopped" && sim.phase !== "ended";

  useEffect(() => {
    setEvaluating(true);
    const t = setTimeout(() => setEvaluating(false), 350);
    return () => clearTimeout(t);
  }, [presetId]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => dispatch({ type: "tick", cond: condRef.current, hasBattery: preset.hasBattery }), TICK_MS);
    return () => clearInterval(id);
  }, [running, preset.hasBattery]);

  const choosePreset = (id: string) => {
    const p = DEVICE_PRESETS.find((x) => x.id === id)!;
    setPresetId(id);
    setCorrupt(false);
    setCond((c) => ({ ...c, battery: p.defaultBatteryPercent ?? 100 }));
    dispatch({ type: "reset" });
  };
  const resetAll = () => {
    setCorrupt(false);
    choosePreset(DEVICE_PRESETS[0]!.id);
    setCond({ externalPower: true, battery: DEVICE_PRESETS[0]!.defaultBatteryPercent ?? 100, network: "unmetered", thermal: "none", dataBudgetGiB: 1, dataUsedGiB: 0.1, minutes: SESSION_DEFAULTS.defaultMinutes });
  };

  const status: { tone: StatusTone; label: string } = (() => {
    if (!elig.mayMeetBaseline) return { tone: "bad", label: "Not compatible" };
    switch (sim.phase) {
      case "idle": return { tone: "idle", label: "Ready" };
      case "waiting": return { tone: "idle", label: "Waiting for work" };
      case "working": return { tone: "busy", label: "Working" };
      case "verifying": return { tone: "busy", label: "Verifying" };
      case "paused": return { tone: "warn", label: sim.pauseReason === "Paused by owner" ? "Paused by owner" : sim.pauseReason?.includes("emperature") || sim.pauseReason?.startsWith("Cooling") ? "Paused for temperature" : "Paused" };
      case "stopped": return { tone: "idle", label: "Stopped" };
      case "ended": return { tone: "idle", label: "Session ended" };
    }
  })();

  const earned = REWARD * BigInt(sim.accepted);
  const sessionLeft = Math.max(0, cond.minutes * 60 - sim.elapsed);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="grid content-start gap-6">
        <Panel title="1. Pick a hypothetical device" chip={<SimChip />}>
          <fieldset>
            <legend className="sr-only">Device preset</legend>
            <div className="grid gap-2">
              {DEVICE_PRESETS.map((p) => (
                <label key={p.id} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${presetId === p.id && !corrupt ? "border-charcoal bg-peach-soft" : "border-line hover:border-charcoal/40"}`}>
                  <input type="radio" name="preset" className="mt-1 accent-orange" checked={presetId === p.id && !corrupt} onChange={() => choosePreset(p.id)} />
                  <span>
                    <span className="font-bold">{p.name}</span>
                    <span className="block font-mono text-[11px] text-charcoal-60">Android {p.androidVersion} · {p.abi} · {p.installedRamGb} GB · {p.hasBattery ? "battery" : "no battery"}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="mt-3 text-xs text-charcoal-60 underline" onClick={() => { setCorrupt(true); dispatch({ type: "reset" }); }}>Test a damaged device fixture</button>
        </Panel>

        <Panel title="2. Owner limits and conditions" chip={<SimChip kind="Proposed" />}>
          <div className="grid gap-4">
            <Field label="Session length" htmlFor="dl-min" hint="Proposed default 30 minutes; shorten, or extend up to 2 hours.">
              <Range id="dl-min" value={cond.minutes} min={SESSION_DEFAULTS.minMinutes} max={SESSION_DEFAULTS.maxMinutes} step={5} suffix=" min" onChange={(v) => setCond({ ...cond, minutes: v })} />
            </Field>
            <Toggle id="dl-power" label="External power connected (required)" checked={cond.externalPower} onChange={(v) => setCond({ ...cond, externalPower: v })} />
            {preset.hasBattery ? (
              <Field label="Battery" htmlFor="dl-bat" hint="Start needs 80% or more; work pauses below 70%.">
                <Range id="dl-bat" value={cond.battery} min={20} max={100} suffix="%" onChange={(v) => setCond({ ...cond, battery: v })} />
              </Field>
            ) : (
              <p className="rounded-lg bg-peach-soft p-3 text-sm">No battery on this device. It follows its tested external-power policy; no battery reading is shown.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Network" htmlFor="dl-net">
                <Select id="dl-net" value={cond.network} onChange={(v) => setCond({ ...cond, network: v as NetworkKind })} options={[{ value: "unmetered", label: "Unmetered Wi-Fi" }, { value: "metered", label: "Mobile data (metered)" }, { value: "offline", label: "Offline" }]} />
              </Field>
              <Field label="Thermal status" htmlFor="dl-th">
                <Select id="dl-th" value={cond.thermal} onChange={(v) => setCond({ ...cond, thermal: v as ThermalStatus })} options={[{ value: "none", label: "Normal" }, { value: "light", label: "Light" }, { value: "moderate", label: "Moderate (reduce load)" }, { value: "severe", label: "Severe (pause)" }, { value: "critical", label: "Critical (pause)" }]} />
              </Field>
            </div>
            <Field label="Data used today" htmlFor="dl-data" hint={`Example budget ${cond.dataBudgetGiB} GiB/day including model downloads.`}>
              <Range id="dl-data" value={cond.dataUsedGiB} min={0} max={1.2} step={0.05} suffix=" GiB" onChange={(v) => setCond({ ...cond, dataUsedGiB: Math.round(v * 100) / 100 })} />
            </Field>
            <dl className="grid grid-cols-2 gap-2 rounded-lg bg-charcoal/[0.03] p-3 text-xs">
              <dt className="text-charcoal-60">Concurrent tasks</dt><dd className="font-mono">{SESSION_DEFAULTS.concurrentTasks}</dd>
              <dt className="text-charcoal-60">CPU inference threads</dt><dd className="font-mono">≤ {SESSION_DEFAULTS.maxCpuThreads}{cond.thermal === "moderate" ? " (reduced)" : ""}</dd>
              <dt className="text-charcoal-60">Model cache</dt><dd className="font-mono">≤ 512 MiB</dd>
            </dl>
          </div>
        </Panel>
      </div>

      <div className="grid content-start gap-6">
        <Panel title="3. Eligibility" chip={<SimChip />}>
          {corrupt ? (
            <ErrorState title="Device fixture could not be read" body="The device data is malformed (missing Android version and memory fields), so nothing can be evaluated. A real app would refuse to start a session." onReset={resetAll} />
          ) : evaluating ? (
            <p className="animate-pulse text-sm text-charcoal-60" aria-live="polite">Evaluating the selected device fixture…</p>
          ) : (
            <div aria-live="polite">
              <p className={`text-lg font-bold ${elig.mayMeetBaseline ? "" : "text-bad"}`}>{elig.summary}</p>
              <ul className="mt-3 grid gap-1.5">
                {elig.checks.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2"><span aria-hidden="true" className={c.pass ? "text-ok" : "text-bad"}>{c.pass ? "✓" : "×"}</span>{c.label}<span className="sr-only">{c.pass ? "passes" : "fails"}</span></span>
                    <span className="font-mono text-xs text-charcoal-60">{c.detail}</span>
                  </li>
                ))}
              </ul>
              {elig.cohortNote && <p className="mt-3 rounded-lg bg-peach-soft p-3 text-sm">{elig.cohortNote}</p>}
              <p className="mt-3 text-xs text-charcoal-60">Passing specifications is not approval. Real admission needs 1,000 calibration records, a 30-minute supervised thermal test and stop, disconnection and restart tests (§3.2). This page never measures your real device.</p>
            </div>
          )}
        </Panel>

        <Panel title="4. Visible session" chip={<SimChip />} actions={<span className="font-mono text-[11px] text-charcoal-60">Demo time ×{SPEED}</span>}>
          {corrupt ? (
            <EmptyState title="No session available" body="Reset the lab to choose a working device fixture." action={<Button variant="ghost" onClick={resetAll}>Reset lab</Button>} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Companion size={40} color={status.tone === "busy" ? "#F07843" : "#ECEEF3"} blinkKey={blink} />
                  <div aria-live="polite">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    {sim.pauseReason && sim.phase === "paused" && sim.pauseReason !== status.label && <p className="mt-1 text-sm">{sim.pauseReason}</p>}
                  </div>
                </div>
                <div className="text-right font-mono text-xs tabular text-charcoal-60">
                  <div>Session left {fmtClock(sessionLeft)}</div>
                  <div>Tasks queued {sim.queue}</div>
                </div>
              </div>

              {sim.phase === "working" && (
                <div className="mt-4">
                  <div className="flex justify-between text-xs"><span>demo-task · 64 records</span><span className="font-mono">{Math.round((sim.taskProgress / TASK_DEMO_SEC) * 100)}%</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-peach"><div className="h-full bg-charcoal transition-[width] duration-200" style={{ width: `${(sim.taskProgress / TASK_DEMO_SEC) * 100}%` }} /></div>
                </div>
              )}
              {sim.phase === "verifying" && <p className="mt-4 text-sm">Submitted. A trusted verifier is recomputing the vectors…</p>}
              {sim.phase === "waiting" && (
                <div className="mt-4">
                  <EmptyState title="Waiting for work" body="No paid demand right now, so nothing is earned. A device never earns for being idle or plugged in." action={<Button variant="ghost" onClick={() => dispatch({ type: "load" })}>Load sample job</Button>} />
                </div>
              )}
              {sim.phase === "idle" && sim.queue === 0 && (
                <p className="mt-4 text-sm text-charcoal-60">Starting this lab never runs real computation on your device or asks for permissions.</p>
              )}
              {sim.phase === "paused" && sim.pauseReason?.startsWith("Cooling") && (
                <p className="mt-4 text-sm">Stable for {fmtClock(sim.thermalStableFor)} of 05:00 (accelerated). The real app waits at least five minutes.</p>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                {(sim.phase === "idle" || sim.phase === "stopped" || sim.phase === "ended") && (
                  <Button variant="accent" disabled={!elig.mayMeetBaseline || evaluating} onClick={() => { dispatch({ type: "start" }); setBlink((b) => b + 1); }}>Start session</Button>
                )}
                {running && sim.pauseReason !== "Paused by owner" && <Button variant="ghost" onClick={() => dispatch({ type: "pauseOwner" })}>Pause</Button>}
                {running && sim.pauseReason === "Paused by owner" && <Button variant="ghost" onClick={() => dispatch({ type: "resume" })}>Resume</Button>}
                {running && <Button variant="primary" onClick={() => dispatch({ type: "stop" })}>Stop</Button>}
                {sim.queue === 0 && sim.phase !== "waiting" && <Button variant="ghost" onClick={() => dispatch({ type: "load" })}>Load sample job</Button>}
                <Button variant="ghost" onClick={resetAll}>Reset</Button>
              </div>
              <p className="mt-2 text-xs text-charcoal-60">Stop responds within one second here. The native app's release target is to stop heavy work within five seconds (§5.2).</p>

              <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
                <div><dt className="text-charcoal-60">Accepted tasks</dt><dd className="font-mono text-lg tabular">{sim.accepted}</dd></div>
                <div><dt className="text-charcoal-60">Provisional reward</dt><dd className="font-mono text-lg tabular">{formatUnits(earned)} <span className="text-xs">USDC</span></dd><dd className="text-[11px] text-charcoal-60">Illustrative rate; not earnings</dd></div>
              </dl>
              {sim.accepted > 0 && <a href="/rewards" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold underline decoration-orange decoration-2 underline-offset-4">See how provisional rewards become claimable →</a>}

              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-bold">Session log ({sim.log.length})</summary>
                <ol className="mt-2 max-h-48 overflow-auto rounded-lg bg-charcoal/[0.03] p-3 font-mono text-xs" aria-live="polite">
                  {sim.log.length === 0 ? <li>No events yet.</li> : sim.log.map((l, i) => <li key={i}><span className="text-charcoal-60">{fmtClock(l.t)}</span> {l.msg}</li>)}
                </ol>
              </details>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
