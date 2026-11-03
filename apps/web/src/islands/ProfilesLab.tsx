import { useState } from "react";
import { DEMO_PROFILE, DEFERRED_PROFILES } from "@andronode/fixtures";
import { VERIFICATION_THRESHOLDS } from "@andronode/protocol/params";
import { useDemo } from "../lib/demoStore";
import SimChip from "../components/SimChip";
import { Button, Panel, StatusBadge } from "../components/ui";

const HASH_PARTS = [
  ["Model weights", "Exact file digest of the converted model"],
  ["Tokenizer", "Vocabulary and normalisation rules"],
  ["Runtime", "ONNX Runtime version and execution provider"],
  ["Precision", "FP32 math; no quantisation in the first profile"],
  ["Pre/post-processing", "Max tokens, pooling, L2 normalisation"],
  ["Output schema", "384 floats per record, record IDs in order"],
] as const;

export default function ProfilesLab() {
  const [demo, setDemo] = useDemo();
  const [showHash, setShowHash] = useState(false);
  const selected = demo.profileId === DEMO_PROFILE.id;
  const rows: [string, string][] = [
    ["Task type", "Text embedding"],
    ["Candidate model", DEMO_PROFILE.candidateModel],
    ["Licence", DEMO_PROFILE.license],
    ["Runtime", DEMO_PROFILE.runtime],
    ["Output", `${DEMO_PROFILE.dimensions} dimensions, L2-normalised`],
    ["Max tokens per record", `${DEMO_PROFILE.maxTokensPerRecord} (longer records are rejected, never truncated)`],
    ["Records per task", `up to ${DEMO_PROFILE.maxRecordsPerTask}`],
    ["Task payload", `up to ${DEMO_PROFILE.maxTaskPayloadBytes / 1024} KiB`],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title={DEMO_PROFILE.title} chip={<SimChip kind="Candidate" />}>
        <p className="font-mono text-xs break-all text-charcoal-60">{DEMO_PROFILE.id}</p>
        <p className="mt-1 text-xs text-charcoal-60">{DEMO_PROFILE.fictionalIdNote}</p>
        <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-charcoal-60">{k}</dt>
              <dd className="break-words">{k === "Candidate model" ? <a className="underline decoration-orange underline-offset-4" href={DEMO_PROFILE.modelSource} target="_blank" rel="noopener noreferrer">{v}</a> : v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-6 rounded-lg bg-peach-soft p-4 text-sm">
          <p className="font-bold">Acceptance tolerances (proposed, §9.1)</p>
          <ul className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-3">
            <li>cosine ≥ {VERIFICATION_THRESHOLDS.minCosine}</li>
            <li>max error ≤ {VERIFICATION_THRESHOLDS.maxAbsError}</li>
            <li>norm {VERIFICATION_THRESHOLDS.minNorm}–{VERIFICATION_THRESHOLDS.maxNorm}</li>
          </ul>
        </div>
        <button type="button" className="mt-4 min-h-11 text-sm font-bold underline decoration-orange decoration-2 underline-offset-4" aria-expanded={showHash} onClick={() => setShowHash(!showHash)}>
          {showHash ? "Hide" : "Show"} what a profile ID pins down
        </button>
        {showHash && (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {HASH_PARTS.map(([k, v]) => (
              <li key={k} className="rounded-lg border border-line p-3 text-sm"><span className="font-bold">{k}</span><span className="block text-charcoal-60">{v}</span></li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Button variant={selected ? "ghost" : "accent"} onClick={() => setDemo({ profileId: selected ? null : DEMO_PROFILE.id })}>{selected ? "Deselect" : "Use this profile in the demo"}</Button>
          {selected && <a href="/workloads" className="inline-flex min-h-11 items-center text-sm font-bold underline decoration-orange decoration-2 underline-offset-4">Next: create a sample workload →</a>}
          <span aria-live="polite" className="text-sm text-charcoal-60">{selected ? "Selected for this browser session." : ""}</span>
        </div>
      </Panel>
      <div className="grid content-start gap-6">
        <Panel title="Not in the first release" chip={<SimChip kind="Proposed" />}>
          <ul className="grid gap-3">
            {DEFERRED_PROFILES.map((p) => (
              <li key={p.id} className="rounded-lg border border-dashed border-charcoal/25 p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><span className="font-bold">{p.title}</span><StatusBadge tone="idle">Deferred</StatusBadge></div>
                <p className="mt-1 text-charcoal-60">{p.reason}</p>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Why one profile">
          <p className="text-sm leading-relaxed text-charcoal-80">Verification compares a device's vectors with a trusted reference. That only works when every device runs the exact same model, tokenizer, runtime and precision. A changed part means a new profile ID and a new round of calibration, so results from different setups are never mixed.</p>
        </Panel>
      </div>
    </div>
  );
}
