import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { verifyMessage, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { newId } from "@andronode/protocol/hash";
import type { AppEnv } from "../env";
import { adminSet, issueSession, requireUser, SESSION_COOKIE } from "../lib/auth";
import { publicClient } from "../lib/chain";
import { bad, body, now, unauthorized } from "../lib/http";

export const auth = new Hono<AppEnv>();

auth.post("/nonce", async (c) => {
  const nonce = newId("siwe", 16).replace("_", "");
  await c.env.DB.prepare("INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)").bind(nonce, now() + 10 * 60_000).run();
  return c.json({ nonce, chainId: Number(c.env.CHAIN_ID), domain: new URL(c.env.SITE_ORIGIN).host, uri: c.env.SITE_ORIGIN });
});

/** Sign-In with Ethereum (EIP-4361). Supports EOAs, and smart wallets (EIP-1271) when an RPC is configured. */
auth.post("/verify", async (c) => {
  const { message, signature } = await body(c, z.object({ message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }));
  const m = parseSiweMessage(message);
  const site = new URL(c.env.SITE_ORIGIN);
  if (!m.address || !m.nonce || m.domain !== site.host) throw bad("SIWE_DOMAIN", "Message domain does not match this site");
  if (m.chainId !== Number(c.env.CHAIN_ID)) throw bad("SIWE_CHAIN", "Wrong chain in sign-in message");
  if (m.expirationTime && m.expirationTime.getTime() < now()) throw bad("SIWE_EXPIRED", "Sign-in message expired");
  const used = await c.env.DB.prepare("UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND expires_at > ?").bind(now(), m.nonce, now()).run();
  if (!used.meta.changes) throw bad("SIWE_NONCE", "Nonce is unknown, expired or already used");
  let ok = await verifyMessage({ address: m.address, message, signature: signature as Hex }).catch(() => false);
  if (!ok) {
    const client = publicClient(c.env);
    if (client) ok = await client.verifyMessage({ address: m.address, message, signature: signature as Hex }).catch(() => false);
  }
  if (!ok) throw unauthorized("Signature does not match the address");
  const address = m.address.toLowerCase();
  const id = newId("acc");
  await c.env.DB.prepare("INSERT INTO accounts (id, address, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING").bind(id, address, now()).run();
  const acct = await c.env.DB.prepare("SELECT id, status FROM accounts WHERE address = ?").bind(address).first<{ id: string; status: string }>();
  if (!acct || acct.status !== "active") throw unauthorized("Account is suspended");
  const { token, expiresAt } = await issueSession(c.env, acct.id, address);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", expires: new Date(expiresAt) });
  return c.json({ token, expiresAt, account: { id: acct.id, address, isAdmin: adminSet(c.env).has(address) } });
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", requireUser, (c) => c.json({ account: c.get("user") }));
