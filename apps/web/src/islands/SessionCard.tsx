import { useEffect, useRef, useState } from "react";
import { allocate, perRecordCharge, formatUnits } from "@andronode/protocol/money";
import { PRICING } from "@andronode/protocol/params";
import Companion from "../components/Companion";
import SimChip from "../components/SimChip";
import { motionAllowed } from "../lib/motion";

/**
 * Home hero: one hypothetical phone walking through a visible session (§5, §8).
 * It explains the process; it is not a live counter and never claims real activity.
 */
const STEPS = [
  { id: "ready", label: "Ready", detail: "Plugged in, on Wi-Fi, battery 92%. Session: 30 min." },
  { id: "leased", label: "Task leased", detail: "64 short English records. Lease expires in 120 s." },
  { id: "working", label: "Working", detail: "Running the embedding profile on 2 CPU threads." },
  { id: "verifying", label: "Verifying", detail: "A trusted verifier recomputes every vector." },
  { id: "accepted", label: "Accepted", detail: "All checks passed. A provisional reward is recorded." },
] as const;

const reward = allocate(perRecordCharge(PRICING.illustrativeRatePer1kUnits) * 64n).contributor;

export default function SessionCard() {
  const [step, setStep] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [auto, setAuto] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAuto(motionAllowed());
    const on = () => setAuto(motionAllowed());
    window.addEventListener("an-motion", on);
    return () => window.removeEventListener("an-motion", on);
  }, []);

  useEffect(() => {
    if (!auto || stopped) return;
    timer.current = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), step === STEPS.length - 1 ? 3200 : 1900);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [step, auto, stopped]);

  const s = STEPS[step]!;
  const progress = s.id === "working" ? 0.6 : s.id === "verifying" || s.id === "accepted" ? 1 : s.id === "leased" ? 0.1 : 0;

  return (
    <div className="slope-card relative bg-charcoal p-6 pt-8 text-paper shadow-2xl sm:p-8 sm:pt-10" aria-label="Simulated device session" role="group">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Companion size={44} color="#F07843" blinkKey={s.id === "accepted" ? step : undefined} />
          <div>
            <p className="font-bold">Mid-range phone</p>
            <p className="font-mono text-xs text-paper/60">Android 14 · arm64 · 6 GB · hypothetical</p>
          </div>
        </div>
        <SimChip kind="Simulation" />
      </div>

      <ol className="mt-6 grid grid-cols-5 gap-1.5" aria-label="Session steps">
        {STEPS.map((x, i) => (
          <li key={x.id} className="min-w-0">
            <div className={`h-1.5 rounded-full transition-colors duration-300 ${i <= step && !stopped ? (i === 4 && step === 4 ? "bg-orange" : "bg-paper") : "bg-paper/20"}`} />
            <span className={`mt-2 block truncate font-mono text-[10px] uppercase tracking-wide sm:text-[11px] ${i === step ? "text-paper" : "text-paper/45"}`}>{x.label}</span>
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-xl bg-paper/[0.06] p-4" aria-live="polite">
        <p className="text-xl font-bold">{stopped ? "Stopped by owner" : s.label}</p>
        <p className="mt-1 text-sm text-paper/75">{stopped ? "No new tasks are taken. Unfinished work is returned and earns nothing — and is never penalised." : s.detail}</p>
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-paper/15">
          <div className="h-full bg-orange transition-[width] duration-500" style={{ width: `${stopped ? 0 : progress * 100}%` }} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-paper/55">Task</dt>
            <dd className="font-mono tabular">demo-task-0001 · 64 rec</dd>
          </div>
          <div>
            <dt className="text-paper/55">Provisional reward</dt>
            <dd className="font-mono tabular">{s.id === "accepted" && !stopped ? `${formatUnits(reward)} USDC` : "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {stopped ? (
          <button type="button" className="min-h-11 rounded-full bg-paper px-5 text-sm font-bold text-charcoal hover:bg-peach" onClick={() => { setStopped(false); setStep(0); }}>
            Start session
          </button>
        ) : (
          <button type="button" className="min-h-11 rounded-full bg-orange px-5 text-sm font-bold text-charcoal hover:brightness-105" onClick={() => setStopped(true)}>
            Stop
          </button>
        )}
        {!auto && !stopped && (
          <button type="button" className="min-h-11 rounded-full border border-paper/30 px-5 text-sm hover:bg-paper/10" onClick={() => setStep((x) => (x + 1) % STEPS.length)}>
            Next step
          </button>
        )}
        <span className="ml-auto font-mono text-[11px] text-paper/50">Illustrative rate: $0.20 / 1,000 accepted records</span>
      </div>
    </div>
  );
}
