import { env, exports } from "cloudflare:workers";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { canonicalJson, digestOf } from "@andronode/protocol/hash";

export const E = env as any;
const keys = JSON.parse(E.TEST_KEYS) as Record<string, `0x${string}`>;

export async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let bodyText: string | undefined;
  if (init.json !== undefined) {
    bodyText = JSON.stringify(init.json);
    headers.set("content-type", "application/json");
  }
  const res = await (exports as any).default.fetch(new Request(`https://andronode.test${path}`, { ...init, headers, body: bodyText ?? init.body }));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

export async function login(who: keyof typeof keys) {
  const acct = privateKeyToAccount(keys[who]!);
  const { data: n } = await call("/v1/auth/nonce", { method: "POST" });
  const message = createSiweMessage({ domain: n.domain, address: acct.address, statement: "Sign in to AndroNode testnet", uri: n.uri, version: "1", chainId: n.chainId, nonce: n.nonce });
  const signature = await acct.signMessage({ message });
  const r = await call("/v1/auth/verify", { method: "POST", json: { message, signature } });
  if (r.status !== 200) throw new Error("login failed " + JSON.stringify(r.data));
  return { token: r.data.token as string, address: acct.address.toLowerCase(), accountId: r.data.account.id as string };
}

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface TestDevice { id: string; key: CryptoKeyPair; sign(msg: string): Promise<string>; call(path: string, init?: { method?: string; json?: unknown; reuse?: Record<string, string> }): Promise<{ status: number; data: any; headers: Record<string, string> }> }

export async function registerDevice(token: string, formFactor = "test-node"): Promise<TestDevice> {
  const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey;
  const sign = async (msg: string) => b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(msg)));
  const { data: ch } = await call("/v1/devices/challenge", { method: "POST", token });
  const reg = await call("/v1/devices/register", { method: "POST", token, json: { publicKeyJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y }, formFactor, challenge: ch.challenge, signature: await sign(ch.sign) } });
  if (reg.status !== 201) throw new Error("register failed " + JSON.stringify(reg.data));
  const id = reg.data.device.id as string;
  return {
    id, key, sign,
    async call(path, init = {}) {
      const method = init.method ?? "GET";
      const body = init.json === undefined ? "" : JSON.stringify(init.json);
      const ts = String(Date.now());
      const headers = init.reuse ?? { "x-an-device": id, "x-an-ts": ts, "x-an-sig": await sign(`AN1\n${method}\n${path}\n${ts}\n${await sha256Hex(body)}`) };
      const r = await call(path, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body || undefined });
      return { ...r, headers };
    },
  };
}

export async function buildResult(dev: TestDevice, leaseId: string, profileId: string, outputs: { id: string; vector: number[] }[]) {
  const output_digest = await digestOf(outputs);
  const core = { lease_id: leaseId, output_digest, completed_record_count: outputs.length, execution_status: "COMPLETED" as const, profile_id: profileId };
  return { ...core, outputs, device_signature: await dev.sign(canonicalJson(core)) };
}

export const records = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, text: `Synthetic public sentence number ${i + 1} about Android devices and verified work.` }));
