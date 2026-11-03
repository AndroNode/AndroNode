import { EMBEDDING_PROFILE_LIMITS } from "./params.js";

/**
 * TESTNET-ONLY stand-in for the real embedding model. Produces a deterministic unit vector
 * from the text so the coordinator, verifier queue and test node can be exercised end to end
 * before the ONNX verifier container is deployed. It has no semantic meaning.
 * The API refuses this mode when NETWORK is "mainnet".
 */
export const FIXTURE_PROFILE_ID = "testnet-fixture/hash-embed/r0";

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function fixtureEmbedding(text: string, dims: number = EMBEDDING_PROFILE_LIMITS.dimensions): number[] {
  let a = fnv1a(text);
  const v = new Array<number>(dims);
  let n = 0;
  for (let i = 0; i < dims; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const x = ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
    v[i] = x;
    n += x * x;
  }
  const norm = Math.sqrt(n);
  return v.map((x) => x / norm);
}
