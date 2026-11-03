import type { MiddlewareHandler } from "hono";
import { sha256Hex } from "@andronode/protocol/hash";
import type { AppEnv } from "../env";
import { ApiError, fromB64url, now } from "./http";

const SKEW_MS = 60_000;

/** Converts a DER ECDSA signature (Android Keystore) to raw r||s (WebCrypto). Raw input passes through. */
export function toRawSignature(sig: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (sig.length === 64 || sig[0] !== 0x30) return sig;
  let i = 2;
  const read = () => {
    if (sig[i++] !== 0x02) throw new Error("bad DER");
    let len = sig[i++]!;
    let v = sig.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

export async function importDeviceKey(jwk: JsonWebKey) {
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function verifyDeviceSig(jwk: JsonWebKey, message: string, sigB64: string): Promise<boolean> {
  try {
    const key = await importDeviceKey(jwk);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, toRawSignature(fromB64url(sigB64)), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export async function keyThumbprint(jwk: { x: string; y: string }): Promise<string> {
  return "dk_" + (await sha256Hex(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`)).slice(0, 40);
}

export async function requestSigningString(method: string, pathWithQuery: string, ts: string, body: string): Promise<string> {
  return `AN1\n${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${await sha256Hex(body)}`;
}

/**
 * Device requests are signed with the device key: headers x-an-device, x-an-ts, x-an-sig.
 * Signatures are single-use within the clock-skew window (replay protection).
 */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deviceId = c.req.header("x-an-device");
  const ts = c.req.header("x-an-ts");
  const sig = c.req.header("x-an-sig");
  if (!deviceId || !ts || !sig) throw new ApiError(401, "DEVICE_AUTH", "Device signature headers missing");
  if (Math.abs(now() - Number(ts)) > SKEW_MS) throw new ApiError(401, "DEVICE_CLOCK", "Device timestamp outside the allowed window");
  const dev = await c.env.DB.prepare("SELECT public_key_jwk, status FROM devices WHERE id = ?").bind(deviceId).first<{ public_key_jwk: string; status: string }>();
  if (!dev) throw new ApiError(401, "DEVICE_AUTH", "Unknown device");
  if (dev.status === "revoked" || dev.status === "suspended") throw new ApiError(403, "DEVICE_BLOCKED", `Device is ${dev.status}`);
  const raw = c.req.method === "GET" ? "" : await c.req.raw.clone().text();
  const url = new URL(c.req.url);
  const msg = await requestSigningString(c.req.method, url.pathname + url.search, ts, raw);
  if (!(await verifyDeviceSig(JSON.parse(dev.public_key_jwk), msg, sig))) throw new ApiError(401, "DEVICE_AUTH", "Bad device signature");
  // Atomic replay guard in D1: a signature can be inserted once. Rows expire after the skew window.
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO device_replay (sig_hash, expires_at) VALUES (?, ?)").bind(await sha256Hex(sig), now() + 3 * SKEW_MS).run();
  if (!ins.meta.changes) throw new ApiError(401, "DEVICE_REPLAY", "Signature already used");
  await c.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now(), deviceId).run();
  c.set("deviceId", deviceId);
  await next();
};
