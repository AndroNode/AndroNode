import { isMainnet } from "./chain";
import { fixtureEmbedding } from "@andronode/protocol/fixture-embed";
import type { Env } from "../env";

export interface Reference { vectors: number[][]; verifier: string }

function assertAllowed(env: Env) {
  if (env.VERIFIER_MODE === "fixture" && isMainnet(env)) throw new Error("Fixture verifier is not allowed on mainnet");
}

async function callVerifier<T>(env: Env, path: string, payload: unknown): Promise<T> {
  if (!env.VERIFIER_URL) throw new Error("VERIFIER_URL is not configured");
  const res = await fetch(env.VERIFIER_URL.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.VERIFIER_TOKEN ?? ""}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Verifier ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Trusted reference vectors for a task's texts (§9.1 full recomputation). */
export async function referenceVectors(env: Env, texts: string[]): Promise<Reference> {
  assertAllowed(env);
  if (env.VERIFIER_MODE === "fixture") return { vectors: texts.map((t) => fixtureEmbedding(t)), verifier: "fixture-ts/r0" };
  const r = await callVerifier<{ vectors: number[][]; verifier: string }>(env, "/embed", { texts });
  return r;
}

/** Token counts per record. Container mode uses the real tokenizer; fixture mode a conservative estimate. */
export async function tokenCounts(env: Env, texts: string[]): Promise<number[]> {
  assertAllowed(env);
  if (env.VERIFIER_MODE === "fixture") {
    return texts.map((t) => Math.max(Math.ceil(t.length / 3), Math.ceil(t.trim().split(/\s+/).length * 1.4)) + 2);
  }
  return (await callVerifier<{ counts: number[] }>(env, "/tokenize", { texts })).counts;
}
