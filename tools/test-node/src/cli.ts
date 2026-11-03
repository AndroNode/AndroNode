#!/usr/bin/env -S npx tsx
/**
 * AndroNode testnet tools.
 *   order  — sign in as a customer and create a mock-funded order of synthetic records (testnet only)
 *   node   — run a simulated contributor device: register, start a session, lease, compute, submit
 *
 * Env: API_URL (default http://localhost:8787), WALLET_PRIVATE_KEY (testnet-only key used to sign in).
 * The device key is stored in .andronode-device.json next to where you run the command.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { canonicalJson, digestOf, sha256Hex } from "@andronode/protocol/hash";
import { fixtureEmbedding } from "@andronode/protocol/fixture-embed";

const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const b64url = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");
const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);

async function api(path: string, init: { method?: string; token?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(API + path, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as any };
}

async function login(): Promise<string> {
  const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("Set WALLET_PRIVATE_KEY to a testnet-only key");
  const acct = privateKeyToAccount(pk);
  const { data: n } = await api("/v1/auth/nonce", { method: "POST" });
  const message = createSiweMessage({ domain: n.domain, address: acct.address, statement: "Sign in to AndroNode testnet", uri: n.uri, version: "1", chainId: n.chainId, nonce: n.nonce });
  const r = await api("/v1/auth/verify", { json: { message, signature: await acct.signMessage({ message }) } });
  if (r.status !== 200) throw new Error(`Sign-in failed: ${JSON.stringify(r.data)}`);
  log("signed in as", acct.address);
  return r.data.token;
}

async function order() {
  const token = await login();
  const n = Number(flag("records", "200"));
  const { data: p } = await api("/v1/profiles");
  const records = Array.from({ length: n }, (_, i) => ({ id: `syn-${i + 1}`, text: `Synthetic public sentence ${i + 1}: Android devices can run short, verifiable embedding tasks.` }));
  const q = await api("/v1/quotes", { token, json: { profileId: p.profiles[0].id, records, acceptDataBoundary: true } });
  if (q.status !== 201) throw new Error(JSON.stringify(q.data));
  log(`quote ${q.data.quote.id}: ${n} records, max ${Number(q.data.quote.maxChargeUnits) / 1e6} USDC`);
  const o = await api("/v1/orders", { token, json: { quoteId: q.data.quote.id, mockFunding: true } });
  log("order", o.data.order?.id, o.data.funding);
}

interface StoredDevice { api: string; deviceId: string; jwk: JsonWebKey }

async function loadOrRegisterDevice(): Promise<{ id: string; key: CryptoKey }> {
  const file = ".andronode-device.json";
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8")) as StoredDevice;
    if (s.api === API) {
      const key = await crypto.subtle.importKey("jwk", s.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { id: s.deviceId, key };
    }
  }
  const token = await login();
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const { data: ch } = await api("/v1/devices/challenge", { method: "POST", token });
  const sig = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(ch.sign)));
  const reg = await api("/v1/devices/register", { token, json: { publicKeyJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y }, formFactor: "test-node", label: flag("label", "cli test node"), challenge: ch.challenge, signature: sig } });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.data)}`);
  writeFileSync(file, JSON.stringify({ api: API, deviceId: reg.data.device.id, jwk: await crypto.subtle.exportKey("jwk", pair.privateKey) }, null, 2), { mode: 0o600 });
  log("registered device", reg.data.device.id);
  return { id: reg.data.device.id, key: pair.privateKey };
}

async function node() {
  const minutes = Number(flag("minutes", "30"));
  const maxTasks = Number(flag("max-tasks", "1000"));
  const corruptEvery = Number(flag("corrupt-every", "0"));
  const dev = await loadOrRegisterDevice();
  const sign = async (msg: string) => b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.key, new TextEncoder().encode(msg)));
  const signed = async (path: string, json?: unknown) => {
    const method = json === undefined ? "GET" : "POST";
    const body = json === undefined ? "" : JSON.stringify(json);
    const ts = String(Date.now());
    const sig = await sign(`AN1\n${method}\n${path}\n${ts}\n${await sha256Hex(body)}`);
    return api(path, { method, json, headers: { "x-an-device": dev.id, "x-an-ts": ts, "x-an-sig": sig } });
  };

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("stop requested: returning any active lease");
    const r = await signed("/v1/node/sessions/stop", {});
    log("stopped", r.data);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const s = await signed("/v1/node/sessions/start", { minutes });
  if (s.status !== 201) throw new Error(JSON.stringify(s.data));
  log(`session ${s.data.session.id} until ${new Date(s.data.session.endsAt).toISOString()}`);
  let done = 0;
  let idle = 0;
  while (!stopping && done < maxTasks && Date.now() < s.data.session.endsAt) {
    const acq = await signed("/v1/node/leases/acquire", {});
    if (acq.status >= 400) throw new Error(JSON.stringify(acq.data));
    if (!acq.data.lease) {
      if (idle++ % 10 === 0) log("waiting for work:", acq.data.status);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    idle = 0;
    const lease = acq.data.lease;
    const inp = await signed(`/v1/node/leases/${lease.lease_id}/input`);
    const corrupt = corruptEvery > 0 && (done + 1) % corruptEvery === 0;
    const outputs = inp.data.records.map((r: { id: string; text: string }) => ({ id: r.id, vector: fixtureEmbedding(r.text).map((x) => (corrupt ? x * 1.01 : x)) }));
    const core = { lease_id: lease.lease_id, output_digest: await digestOf(outputs), completed_record_count: outputs.length, execution_status: "COMPLETED", profile_id: lease.profile_id };
    const sub = await signed(`/v1/node/leases/${lease.lease_id}/result`, { ...core, outputs, device_signature: await sign(canonicalJson(core)) });
    done++;
    log(`task ${lease.task_id} (${lease.record_count} records, reward ${Number(lease.reward_units) / 1e6} USDC) → ${sub.data.state ?? JSON.stringify(sub.data)}${corrupt ? " [deliberately corrupted]" : ""}`);
  }
  await signed("/v1/node/sessions/stop", {});
  log(`session finished after ${done} task(s)`);
}

const commands: Record<string, () => Promise<void>> = { order, node };
if (!cmd || !commands[cmd]) {
  console.log("usage: andronode-test-node <order|node> [--records N] [--minutes M] [--max-tasks K] [--corrupt-every N]");
  process.exit(cmd ? 1 : 0);
}
commands[cmd]!().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
