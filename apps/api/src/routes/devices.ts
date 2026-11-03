import { Hono } from "hono";
import { z } from "zod";
import { newId } from "@andronode/protocol/hash";
import { deviceRegisterSchema, resultEnvelopeSchema, sessionStartSchema } from "@andronode/protocol/schemas";
import { LEASE_RULES } from "@andronode/protocol/params";
import type { AppEnv } from "../env";
import { requireUser } from "../lib/auth";
import { keyThumbprint, requireDevice, verifyDeviceSig } from "../lib/device-auth";
import { ApiError, bad, body, conflict, notFound, now } from "../lib/http";
import { acquireLease, submitResult, type LeaseRow, type TaskRow } from "../lib/leasing";
import { loadRecords, sweep } from "../lib/orders";

/** Owner-facing device management (wallet session). */
export const devices = new Hono<AppEnv>();

devices.post("/challenge", requireUser, async (c) => {
  const nonce = newId("dch", 16);
  await c.env.DB.prepare("INSERT INTO device_challenges (nonce, account_id, expires_at) VALUES (?, ?, ?)").bind(nonce, c.get("user").accountId, now() + 10 * 60_000).run();
  return c.json({ challenge: nonce, sign: `andronode-register:${nonce}` });
});

/** Binds a device public key after proof of possession (§3.2, §10). */
devices.post("/register", requireUser, async (c) => {
  const user = c.get("user");
  const req = await body(c, deviceRegisterSchema);
  const ch = await c.env.DB.prepare("UPDATE device_challenges SET used_at = ? WHERE nonce = ? AND account_id = ? AND used_at IS NULL AND expires_at > ?").bind(now(), req.challenge, user.accountId, now()).run();
  if (!ch.meta.changes) throw bad("CHALLENGE", "Challenge is unknown, expired or used");
  if (!(await verifyDeviceSig(req.publicKeyJwk, `andronode-register:${req.challenge}`, req.signature))) throw bad("INVALID_SIGNATURE", "Proof of key possession failed");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND status != 'revoked'").bind(user.accountId).first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) throw conflict("DEVICE_LIMIT", "Testnet accounts may register up to 20 devices");
  const keyId = await keyThumbprint(req.publicKeyJwk);
  const id = newId("dev");
  try {
    await c.env.DB.prepare("INSERT INTO devices (id, account_id, key_id, public_key_jwk, form_factor, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, user.accountId, keyId, JSON.stringify(req.publicKeyJwk), req.formFactor, req.label ?? null, now()).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("KEY_REGISTERED", "This device key is already registered");
    throw e;
  }
  return c.json({ device: { id, keyId, status: "probation" } }, 201);
});

devices.get("/", requireUser, async (c) => {
  const rows = await c.env.DB.prepare(`SELECT d.id, d.key_id, d.form_factor, d.label, d.status, d.accepted_tasks, d.rejected_tasks, d.created_at, d.last_seen_at,
      (SELECT ends_at FROM device_sessions s WHERE s.device_id = d.id AND s.stopped_at IS NULL AND s.ends_at > ?1 ORDER BY started_at DESC LIMIT 1) AS session_ends_at,
      (SELECT state FROM leases l WHERE l.device_id = d.id ORDER BY issued_at DESC LIMIT 1) AS last_lease_state
    FROM devices d WHERE d.account_id = ?2 ORDER BY d.created_at`).bind(now(), c.get("user").accountId).all();
  return c.json({ devices: rows.results });
});

devices.post("/:id/revoke", requireUser, async (c) => {
  const r = await c.env.DB.prepare("UPDATE devices SET status = 'revoked' WHERE id = ? AND account_id = ?").bind(c.req.param("id"), c.get("user").accountId).run();
  if (!r.meta.changes) throw notFound("Device");
  await c.env.DB.prepare("UPDATE device_sessions SET stopped_at = ? WHERE device_id = ? AND stopped_at IS NULL").bind(now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Device-signed endpoints: sessions and leases. */
export const node = new Hono<AppEnv>();
node.use("*", requireDevice);

node.post("/sessions/start", async (c) => {
  const deviceId = c.get("deviceId");
  const req = await body(c, sessionStartSchema.omit({ deviceId: true }).extend({ deviceId: z.string().optional() }));
  const at = now();
  await c.env.DB.prepare("UPDATE device_sessions SET stopped_at = ? WHERE device_id = ? AND stopped_at IS NULL").bind(at, deviceId).run();
  const id = newId("ses");
  const endsAt = at + (req.minutes ?? 30) * 60_000;
  await c.env.DB.prepare("INSERT INTO device_sessions (id, device_id, started_at, ends_at, limits_json) VALUES (?, ?, ?, ?, ?)").bind(id, deviceId, at, endsAt, JSON.stringify(req.limits)).run();
  return c.json({ session: { id, endsAt, heartbeatSeconds: LEASE_RULES.heartbeatSeconds } }, 201);
});

/** Stop: no new leases; an active lease is returned unfinished with no partial reward and no penalty (§22.3). */
node.post("/sessions/stop", async (c) => {
  const deviceId = c.get("deviceId");
  const at = now();
  const open = await c.env.DB.prepare("SELECT id, task_id FROM leases WHERE device_id = ? AND state = 'LEASED'").bind(deviceId).all<{ id: string; task_id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE device_sessions SET stopped_at = ? WHERE device_id = ? AND stopped_at IS NULL").bind(at, deviceId),
    ...open.results.flatMap((l) => [
      c.env.DB.prepare("UPDATE leases SET state = 'RETURNED', reason = 'OWNER_STOP' WHERE id = ? AND state = 'LEASED'").bind(l.id),
      c.env.DB.prepare("UPDATE tasks SET state = CASE WHEN (SELECT state FROM orders WHERE id = tasks.order_id) = 'CANCELLED' THEN 'CANCELLED' ELSE 'QUEUED' END, attempts = MAX(attempts - 1, 0), current_lease_id = NULL, updated_at = ? WHERE id = ? AND current_lease_id = ? AND state = 'LEASED'").bind(at, l.task_id, l.id),
    ]),
  ]);
  return c.json({ stopped: true, returnedLeases: open.results.map((l) => l.id) });
});

node.post("/leases/acquire", async (c) => {
  const r = await acquireLease(c.env, c.get("deviceId"), now());
  if (r.kind === "none") return c.json({ lease: null, status: r.reason }, 200);
  return c.json({ lease: r.envelope }, 201);
});

async function ownLease(c: any): Promise<LeaseRow> {
  const l = await c.env.DB.prepare("SELECT * FROM leases WHERE id = ? AND device_id = ?").bind(c.req.param("id"), c.get("deviceId")).first();
  if (!l) throw notFound("Lease");
  return l as LeaseRow;
}

/** Task inputs, available only to the leasing device while the lease is live (§11 scoped access). */
node.get("/leases/:id/input", async (c) => {
  const l = await ownLease(c);
  if (l.state !== "LEASED" || l.expires_at < now()) throw conflict("LEASE_NOT_ACTIVE", `Lease is ${l.state}`);
  const t = (await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(l.task_id).first<TaskRow>())!;
  const q = (await c.env.DB.prepare("SELECT q.records_key, q.profile_id FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.id = ?").bind(t.order_id).first<{ records_key: string; profile_id: string }>())!;
  const records = (await loadRecords(c.env, q.records_key)).slice(t.record_start, t.record_start + t.record_count).map((r) => ({ id: r.id, text: r.text }));
  c.header("cache-control", "no-store");
  return c.json({ leaseId: l.id, profileId: q.profile_id, inputDigest: t.input_digest, records });
});

/** Heartbeats are recorded but never extend the deadline (§8.2). */
node.post("/leases/:id/heartbeat", async (c) => {
  const l = await ownLease(c);
  return c.json({ leaseId: l.id, state: l.state, expiresAt: l.expires_at, serverTime: now() });
});

node.post("/leases/:id/result", async (c) => {
  const env_ = await body(c, resultEnvelopeSchema);
  if (env_.outputs.length > 64) throw bad("TOO_MANY_OUTPUTS", "At most 64 outputs per task");
  const out = await submitResult(c.env, c.get("deviceId"), c.req.param("id"), env_, now());
  if (out.enqueue) await c.env.VERIFY_QUEUE.send({ leaseId: c.req.param("id") });
  return c.json(out.body, out.status as 200 | 202);
});

node.get("/leases/:id", async (c) => {
  const l = await ownLease(c);
  const rc = await c.env.DB.prepare("SELECT id, decision, reason, stats_json FROM receipts WHERE lease_id = ?").bind(l.id).first();
  return c.json({ lease: l, receipt: rc ?? null });
});

node.get("/me", async (c) => {
  await sweep(c.env, now());
  const d = await c.env.DB.prepare("SELECT id, status, accepted_tasks, rejected_tasks FROM devices WHERE id = ?").bind(c.get("deviceId")).first();
  if (!d) throw new ApiError(404, "NOT_FOUND", "Device not found");
  return c.json({ device: d });
});
