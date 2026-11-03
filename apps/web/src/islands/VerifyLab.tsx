import { useMemo, useState } from "react";
import { DEMO_PROFILE, RECEIPT_CASES, authoredVector, deviceVector, submittedVectorsFor, type ReceiptCaseId } from "@andronode/fixtures";
import { verifySubmission } from "@andronode/protocol/verify";
import { REJECTION_REASONS } from "@andronode/protocol/states";
import { VERIFICATION_THRESHOLDS } from "@andronode/protocol/params";
import { useDemo } from "../lib/demoStore";
import { download, copyText } from "../lib/format";
import SimChip from "../components/SimChip";
import { Button, Field, Panel, Range, Select, StatusBadge } from "../components/ui";

type CaseKey = ReceiptCaseId | "custom-noise";

export default function VerifyLab() {
  const [demo] = useDemo();
  const [caseId, setCaseId] = useState<CaseKey>("valid");
  const [noiseExp, setNoiseExp] = useState(-5); // noise = 10^exp
  const [copied, setCopied] = useState(false);
  const c = RECEIPT_CASES.find((x) => x.id === (caseId === "custom-noise" ? "valid" : caseId))!;

  const report = useMemo(() => {
    const submitted = caseId === "custom-noise" ? c.recordIds.map((id) => deviceVector(id, 10 ** noiseExp)) : submittedVectorsFor(c);
    return verifySubmission({
      expectedRecordIds: c.recordIds,
      expectedProfileId: DEMO_PROFILE.id,
      submittedProfileId: c.submittedProfileId,
      submittedRecordIds: c.recordIds,
      submittedVectors: submitted,
      referenceVectors: c.recordIds.map((id) => authoredVector(id)),
      submittedAt: c.submittedAtOffsetSec * 1000,
      leaseExpiresAt: c.leaseSeconds * 1000,
      signatureValid: true,
    });
  }, [c, caseId, noiseExp]);

  const receipt = {
    receiptId: caseId === "custom-noise" ? "demo-rcpt-custom" : c.receiptId,
    orderId: c.orderId,
    taskId: c.taskId,
    leaseId: c.leaseId,
    profileId: c.submittedProfileId,
    records: c.recordIds.length,
    submittedAfterLeaseStartSec: c.submittedAtOffsetSec,
    leaseSeconds: c.leaseSeconds,
    decision: report.decision,
    reason: report.reason,
    worst: report.worst,
    notice: "Simulation receipt. Not issued by a live network.",
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="grid content-start gap-6">
        <Panel title="Choose a submission" chip={<SimChip />}>
          <Field label="Receipt case" htmlFor="vf-case">
            <Select id="vf-case" value={caseId} onChange={(v) => setCaseId(v as CaseKey)} options={[...RECEIPT_CASES.map((r) => ({ value: r.id, label: r.title })), { value: "custom-noise", label: "Adjust numeric noise yourself" }]} />
          </Field>
          {caseId === "custom-noise" && (
            <div className="mt-4">
              <Field label="Device numeric noise per value" htmlFor="vf-noise" hint="Different CPUs give slightly different floats. Bigger noise eventually breaks the tolerance.">
                <Range id="vf-noise" value={noiseExp} min={-7} max={-1} step={0.25} onChange={setNoiseExp} />
              </Field>
              <p className="font-mono text-xs">± {(10 ** noiseExp).toExponential(1)}</p>
            </div>
          )}
          <dl className="mt-5 grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-charcoal-60">Order</dt><dd className="font-mono text-xs">{c.orderId}</dd>
            <dt className="text-charcoal-60">Task</dt><dd className="font-mono text-xs">{c.taskId}</dd>
            <dt className="text-charcoal-60">Lease</dt><dd className="font-mono text-xs">{c.leaseId} · {c.leaseSeconds}s</dd>
            <dt className="text-charcoal-60">Submitted</dt><dd className="font-mono text-xs">{c.submittedAtOffsetSec}s after lease start</dd>
            <dt className="text-charcoal-60">Records</dt><dd className="font-mono text-xs">{c.recordIds.join(", ")}</dd>
          </dl>
        </Panel>
        {demo.order && (
          <Panel title="From your workload" chip={<SimChip />}>
            <p className="text-sm">{demo.order.receiptIds.length} accepted task receipt{demo.order.receiptIds.length === 1 ? "" : "s"}{demo.order.rejected.length ? `, ${demo.order.rejected.length} rejected attempt` : ""} in order <span className="font-mono text-xs">{demo.order.orderId}</span>.</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">{demo.order.receiptIds.map((r) => <li key={r} className="rounded-full bg-peach-soft px-2 py-0.5 font-mono text-[11px]">{r}</li>)}</ul>
          </Panel>
        )}
      </div>

      <Panel title="Verification report" chip={<SimChip />}>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <StatusBadge tone={report.decision === "ACCEPTED" ? "ok" : "bad"}>{report.decision === "ACCEPTED" ? "Accepted" : "Rejected"}</StatusBadge>
          {report.reason && <span className="font-mono text-xs">{report.reason}</span>}
        </div>
        {report.reason && <p className="mt-2 text-sm">{REJECTION_REASONS[report.reason]}</p>}
        <ol className="mt-5 grid gap-2">
          {report.checks.map((k, i) => (
            <li key={k.id} className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm ${k.pass ? "border-line" : "border-bad/40 bg-bad/5"}`}>
              <span className="flex gap-2"><span className="font-mono text-xs text-charcoal-60">{i + 1}</span><span aria-hidden="true" className={k.pass ? "text-ok" : "text-bad"}>{k.pass ? "✓" : "×"}</span>{k.label}<span className="sr-only">{k.pass ? "passed" : "failed"}</span></span>
              <span className="max-w-[55%] break-words text-right font-mono text-xs text-charcoal-60">{k.detail}</span>
            </li>
          ))}
        </ol>
        {report.worst && (
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {([
              ["Worst cosine", report.worst.cosine.toFixed(7), `≥ ${VERIFICATION_THRESHOLDS.minCosine}`, report.worst.cosine >= VERIFICATION_THRESHOLDS.minCosine],
              ["Max abs error", report.worst.maxAbsError.toExponential(2), `≤ ${VERIFICATION_THRESHOLDS.maxAbsError}`, report.worst.maxAbsError <= VERIFICATION_THRESHOLDS.maxAbsError],
              ["Vector norm", report.worst.norm.toFixed(5), `${VERIFICATION_THRESHOLDS.minNorm}–${VERIFICATION_THRESHOLDS.maxNorm}`, report.worst.norm >= VERIFICATION_THRESHOLDS.minNorm && report.worst.norm <= VERIFICATION_THRESHOLDS.maxNorm],
            ] as const).map(([k, v, lim, ok]) => (
              <div key={k} className={`rounded-lg border p-3 ${ok ? "border-line" : "border-bad/40"}`}>
                <div className="text-xs text-charcoal-60">{k}</div>
                <div className="font-mono text-lg tabular">{v}</div>
                <div className="font-mono text-[11px] text-charcoal-60">needs {lim}</div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-charcoal-60">The first profile uses full-reference checking: a trusted verifier recomputes every record. Reference vectors here are authored fixtures, not real model output. A rejected attempt earns nothing and the customer is not charged; the task is retried elsewhere.</p>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={() => download(`${receipt.receiptId}.json`, JSON.stringify(receipt, null, 2))}>Download receipt</Button>
          <Button variant="ghost" onClick={async () => { setCopied(await copyText(receipt.receiptId)); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy receipt ID"}</Button>
        </div>
      </Panel>
    </div>
  );
}
