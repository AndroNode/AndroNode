import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sha256Hex } from "@andronode/protocol/hash";
import type { AppEnv, AuthUser, Env } from "../env";
import { b64url, forbidden, fromB64url, now, unauthorized } from "./http";

const SESSION_TTL_MS = 12 * 3600 * 1000;
export const SESSION_COOKIE = "an_session";

async function hmacKey(secret: string) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSession(env: Env, accountId: string, address: string): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now() + SESSION_TTL_MS;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub: accountId, addr: address, exp: expiresAt })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), new TextEncoder().encode(payload));
  return { token: `ans1.${payload}.${b64url(sig)}`, expiresAt };
}

async function readSession(env: Env, token: string): Promise<{ sub: string; addr: string } | null> {
  const [v, payload, sig] = token.split(".");
  if (v !== "ans1" || !payload || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), fromB64url(sig), new TextEncoder().encode(payload));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { sub: string; addr: string; exp: number };
  return data.exp > now() ? data : null;
}

export const adminSet = (env: Env) => new Set(env.ADMIN_ADDRESSES.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));

async function resolveUser(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<AuthUser | null> {
  const header = c.req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const token = bearer ?? getCookie(c, SESSION_COOKIE) ?? null;
  if (!token) return null;
  if (token.startsWith("ank_")) {
    const row = await c.env.DB.prepare(
      "SELECT a.id, a.address, a.status FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.secret_hash = ? AND k.revoked_at IS NULL",
    ).bind(await sha256Hex(token)).first<{ id: string; address: string; status: string }>();
    if (!row || row.status !== "active") return null;
    return { accountId: row.id, address: row.address, isAdmin: false, via: "api_key" };
  }
  const s = await readSession(c.env, token);
  if (!s) return null;
  const acct = await c.env.DB.prepare("SELECT status FROM accounts WHERE id = ?").bind(s.sub).first<{ status: string }>();
  if (!acct || acct.status !== "active") return null;
  return { accountId: s.sub, address: s.addr, isAdmin: adminSet(c.env).has(s.addr), via: "session" };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = await resolveUser(c);
  if (!u) throw unauthorized();
  c.set("user", u);
  await next();
};

/** Admin actions require a wallet session (never an API key) from an allowlisted address. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = await resolveUser(c);
  if (!u) throw unauthorized();
  if (!u.isAdmin || u.via !== "session") throw forbidden("Admin wallet required");
  c.set("user", u);
  await next();
};
