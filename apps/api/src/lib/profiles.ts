import { EMBEDDING_PROFILE_LIMITS, VERIFICATION_THRESHOLDS } from "@andronode/protocol/params";
import { FIXTURE_PROFILE_ID } from "@andronode/protocol/fixture-embed";
import type { Env } from "../env";

export interface ApiProfile {
  id: string;
  title: string;
  status: "testnet" | "candidate";
  taskType: "embedding";
  model: string;
  runtime: string;
  dimensions: number;
  maxTokensPerRecord: number;
  maxRecordsPerTask: number;
  maxTaskPayloadBytes: number;
  thresholds: typeof VERIFICATION_THRESHOLDS;
  note: string;
}

const base = {
  taskType: "embedding" as const,
  dimensions: EMBEDDING_PROFILE_LIMITS.dimensions,
  maxTokensPerRecord: EMBEDDING_PROFILE_LIMITS.maxTokensPerRecord,
  maxRecordsPerTask: EMBEDDING_PROFILE_LIMITS.maxRecordsPerTask,
  maxTaskPayloadBytes: EMBEDDING_PROFILE_LIMITS.maxTaskPayloadBytes,
  thresholds: VERIFICATION_THRESHOLDS,
};

export const MINILM_PROFILE_ID = "minilm-l6-v2/onnx-cpu-fp32/r0";

/** Profiles offered by this deployment. Fixture mode exists only to exercise the pipeline on testnet. */
export function activeProfiles(env: Env): ApiProfile[] {
  if (env.VERIFIER_MODE === "container") {
    return [{ ...base, id: MINILM_PROFILE_ID, title: "Short English text embedding", status: "candidate", model: "sentence-transformers/all-MiniLM-L6-v2", runtime: "ONNX Runtime CPU FP32", note: "Candidate profile on testnet. Not calibrated for paid use." }];
  }
  return [{ ...base, id: FIXTURE_PROFILE_ID, title: "Pipeline test profile (hash embedding)", status: "testnet", model: "deterministic hash embedding (no model)", runtime: "TypeScript reference", note: "Testnet only. Vectors have no meaning; used to exercise leasing, verification and settlement." }];
}

export const findProfile = (env: Env, id: string) => activeProfiles(env).find((p) => p.id === id) ?? null;
