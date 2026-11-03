import { EMBEDDING_PROFILE_LIMITS, VERIFICATION_THRESHOLDS } from "./params.js";
import type { RejectionReason } from "./states.js";

export interface VectorStats {
  cosine: number;
  maxAbsError: number;
  norm: number;
}

export interface VerificationInput {
  expectedRecordIds: string[];
  expectedProfileId: string;
  submittedProfileId: string;
  submittedRecordIds: string[];
  submittedVectors: number[][];
  referenceVectors: number[][];
  submittedAt: number;
  leaseExpiresAt: number;
  signatureValid: boolean;
  dimensions?: number;
  thresholds?: typeof VERIFICATION_THRESHOLDS;
}

export interface VerificationCheck {
  id: "signature" | "deadline" | "profile" | "schema" | "finite" | "numeric";
  label: string;
  pass: boolean;
  detail: string;
}

export interface VerificationReport {
  decision: "ACCEPTED" | "REJECTED";
  reason: RejectionReason | null;
  checks: VerificationCheck[];
  worst: VectorStats | null;
}

export function l2(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function compareVectors(a: number[], b: number[]): VectorStats {
  let dot = 0;
  let maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    maxAbs = Math.max(maxAbs, Math.abs(x - y));
  }
  const na = l2(a);
  const nb = l2(b);
  const cosine = na === 0 || nb === 0 ? 0 : dot / (na * nb);
  return { cosine, maxAbsError: maxAbs, norm: na };
}

/**
 * Full-reference check for the embedding profile (§9.1).
 * All checks must pass; the first failing check gives the reason code (§9.2).
 */
export function verifySubmission(input: VerificationInput): VerificationReport {
  const t = input.thresholds ?? VERIFICATION_THRESHOLDS;
  const dims = input.dimensions ?? EMBEDDING_PROFILE_LIMITS.dimensions;
  const checks: VerificationCheck[] = [];
  let reason: RejectionReason | null = null;
  const fail = (r: RejectionReason) => {
    if (!reason) reason = r;
  };

  checks.push({ id: "signature", label: "Device signature", pass: input.signatureValid, detail: input.signatureValid ? "Matches registered key" : "Does not match" });
  if (!input.signatureValid) fail("INVALID_SIGNATURE");

  const onTime = input.submittedAt <= input.leaseExpiresAt;
  checks.push({ id: "deadline", label: "Submitted before lease expiry", pass: onTime, detail: onTime ? "On time" : "Late" });
  if (!onTime) fail("LEASE_EXPIRED");

  const profileOk = input.submittedProfileId === input.expectedProfileId;
  checks.push({ id: "profile", label: "Model profile", pass: profileOk, detail: profileOk ? input.submittedProfileId : `Expected ${input.expectedProfileId}, got ${input.submittedProfileId}` });
  if (!profileOk) fail("WRONG_PROFILE");

  const idsOk =
    input.submittedRecordIds.length === input.expectedRecordIds.length &&
    input.submittedRecordIds.every((id, i) => id === input.expectedRecordIds[i]);
  const countOk = input.submittedVectors.length === input.expectedRecordIds.length;
  const dimsOk = input.submittedVectors.every((v) => v.length === dims);
  const schemaOk = idsOk && countOk && dimsOk;
  checks.push({
    id: "schema",
    label: `Record IDs, count and ${dims} dimensions`,
    pass: schemaOk,
    detail: !idsOk ? "Record IDs differ" : !countOk ? "Vector count differs" : !dimsOk ? "Wrong vector dimensions" : "Matches",
  });
  if (!schemaOk) fail("SCHEMA_ERROR");

  const finite = input.submittedVectors.every((v) => v.every((x) => Number.isFinite(x)));
  checks.push({ id: "finite", label: "Finite values", pass: finite, detail: finite ? "No NaN or infinity" : "NaN or infinity found" });
  if (!finite) fail("NONFINITE_OUTPUT");

  let worst: VectorStats | null = null;
  let numericOk = false;
  if (schemaOk && finite && input.referenceVectors.length === input.submittedVectors.length) {
    numericOk = true;
    let minCos = Infinity;
    let maxErr = 0;
    let worstNorm = 1;
    for (let i = 0; i < input.submittedVectors.length; i++) {
      const s = compareVectors(input.submittedVectors[i]!, input.referenceVectors[i]!);
      minCos = Math.min(minCos, s.cosine);
      maxErr = Math.max(maxErr, s.maxAbsError);
      if (Math.abs(s.norm - 1) > Math.abs(worstNorm - 1)) worstNorm = s.norm;
      if (s.cosine < t.minCosine || s.maxAbsError > t.maxAbsError || s.norm < t.minNorm || s.norm > t.maxNorm) {
        numericOk = false;
      }
    }
    worst = { cosine: minCos, maxAbsError: maxErr, norm: worstNorm };
  }
  checks.push({
    id: "numeric",
    label: `Cosine ≥ ${t.minCosine}, max error ≤ ${t.maxAbsError}, norm ${t.minNorm}–${t.maxNorm}`,
    pass: numericOk,
    detail: worst ? `Worst cosine ${worst.cosine.toFixed(6)}, max error ${worst.maxAbsError.toExponential(2)}` : "Not compared",
  });
  if (!numericOk) fail("NUMERIC_MISMATCH");

  return { decision: reason ? "REJECTED" : "ACCEPTED", reason, checks, worst };
}
