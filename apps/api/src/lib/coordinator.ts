import { canonicalJson } from "@andronode/protocol/hash";
import type { Env } from "../env";
import { b64url } from "./http";

let cached: { jwk: string; key: CryptoKey; pub: JsonWebKey } | null = null;

async function load(env: Env) {
  if (cached && cached.jwk === env.COORDINATOR_KEY_JWK) return cached;
  if (!env.COORDINATOR_KEY_JWK) throw new Error("COORDINATOR_KEY_JWK secret is not set");
  const jwk = JSON.parse(env.COORDINATOR_KEY_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const { d: _d, key_ops: _k, ...pub } = jwk;
  cached = { jwk: env.COORDINATOR_KEY_JWK, key, pub };
  return cached;
}

/** Signs a lease envelope so devices can check it came from the coordinator (§22.2). */
export async function signEnvelope(env: Env, envelope: Record<string, unknown>): Promise<string> {
  const { key } = await load(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(canonicalJson(envelope)));
  return b64url(sig);
}

export async function coordinatorPublicKey(env: Env): Promise<JsonWebKey> {
  return (await load(env)).pub;
}
