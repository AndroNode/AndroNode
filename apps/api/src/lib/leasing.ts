import { newId, digestOf, canonicalJson } from "@andronode/protocol/hash";
import { LEASE_RULES, PILOT_CAPS, PROBATION } from "@andronode/protocol/params";
import { PROTOCOL_VERSION, type ResultEnvelope } from "@andronode/protocol/schemas";
import type { Env } from "../env";
import { signEnvelope } from "./coordinator";
import { verifyDeviceSig } from "./device-auth";
import { ApiError, conflict } from "./http";
import { sweep } from "./orders";

const EST_EXEC_SECONDS = 30;

export interface TaskRow { id: string; order_id: string; idx: number; record_start: number; record_count: number; charge_units: number; reward_units: number; input_digest: string; generation: number; attempts: number; state: string; current_lease_id: string | null }
export interface LeaseRow { id: string; task_id: string; device_id: string; generation: number; reward_units: number; nonce: string; issued_at: number; expires_at: number; state: string; output_digest: string | null; submitted_at: number | null; reason: string | null }

async function activeSession(db: D1Database, deviceId: string, at: number) {
  return db.prepare("SELECT id, ends_at FROM device_sessions WHERE device_id = ? AND stopped_at IS NULL AND ends_at > ? ORDER BY started_at DESC LIMIT 1").bind(deviceId, at).first<{ id: string; ends_at: number }>();
}

/** Unsettled contributor exposure: active leases, in-flight submissions and unsettled rewards (§13.3). */
async function exposure(db: D1Database, where: string, arg: string | null) {
  const leases = await db.prepare(`SELECT COALESCE(SUM(l.reward_units),0) AS s FROM leases l JOIN devices d ON d.id = l.device_id WHERE l.state IN ('LEASED','SUBMITTED','VERIFYING') ${where}`).bind(...(arg ? [arg] : [])).first<{ s: number }>();
  const rewards = await db.prepare(`SELECT COALESCE(SUM(r.units),0) AS s FROM rewards r JOIN devices d ON d.id = r.device_id WHERE r.state IN ('PROVISIONAL','HELD') ${where}`).bind(...(arg ? [arg] : [])).first<{ s: number }>();
  return BigInt(leases?.s ?? 0) + BigInt(rewards?.s ?? 0);
}

export type AcquireResult = { kind: "lease"; envelope: Record<string, unknown> } | { kind: "none"; reason: string };

/** §8.2: issues at most one lease per device, atomically, only if it fits before the order deadline. */
export async function acquireLease(env: Env, deviceId: string, at: number): Promise<AcquireResult> {
  const db = env.DB;
  await sweep(env, at);
  const session = await activeSession(db, deviceId, at);
  if (!session) throw new ApiError(409, "NO_SESSION", "Start a session before requesting work");
  const open = await db.prepare("SELECT id FROM leases WHERE device_id = ? AND state = 'LEASED' LIMIT 1").bind(deviceId).first<{ id: string }>();
  if (open) throw conflict("ACTIVE_LEASE", `Device already holds lease ${open.id}`);
  const dev = await db.prepare("SELECT account_id, status FROM devices WHERE id = ?").bind(deviceId).first<{ account_id: string; status: string }>();
  if (!dev) throw new ApiError(404, "NOT_FOUND", "Device not found");

  const latest = Math.min(session.ends_at, Number.MAX_SAFE_INTEGER);
  const candidates = await db.prepare(`
    SELECT t.*, o.deadline_at, q.profile_id FROM tasks t
      JOIN orders o ON o.id = t.order_id JOIN quotes q ON q.id = o.quote_id
     WHERE t.state = 'QUEUED' AND o.state IN ('FUNDED','RUNNING') AND t.attempts < ?
       AND o.deadline_at > ? AND ? <= ?
       AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.task_id = t.id AND l.device_id = ? AND l.state = 'REJECTED')
     ORDER BY o.funded_at, t.idx LIMIT 5`)
    .bind(LEASE_RULES.maxAutomaticAttempts, at + (EST_EXEC_SECONDS + LEASE_RULES.uploadMarginSeconds) * 1000, at + EST_EXEC_SECONDS * 1000, latest, deviceId)
    .all<TaskRow & { deadline_at: number; profile_id: string }>();
  if (!candidates.results.length) return { kind: "none", reason: "WAITING_FOR_WORK" };

  const network = await exposure(db, "", null);
  const device = await exposure(db, "AND d.id = ?", deviceId);
  const account = await exposure(db, "AND d.account_id = ?", dev.account_id);

  for (const t of candidates.results) {
    const reward = BigInt(t.reward_units);
    if (network + reward > PILOT_CAPS.maxUnsettledExposureUnits) return { kind: "none", reason: "NETWORK_EXPOSURE_CAP" };
    if (dev.status === "probation" && device + reward > PROBATION.deviceProvisionalCapUnits) return { kind: "none", reason: "PROBATION_DEVICE_CAP" };
    if (account + reward > PROBATION.accountProvisionalCapUnits) return { kind: "none", reason: "PROBATION_ACCOUNT_CAP" };
    const expiresAt = Math.min(at + LEASE_RULES.maxLeaseSeconds * 1000, t.deadline_at);
    if (at + (EST_EXEC_SECONDS + LEASE_RULES.uploadMarginSeconds) * 1000 > expiresAt) continue;
    const leaseId = newId("lse");
    const nonce = newId("n", 16);
    const gen = t.generation + 1;
    const [upd] = await db.batch([
      db.prepare("UPDATE tasks SET state = 'LEASED', generation = ?, attempts = attempts + 1, current_lease_id = ?, updated_at = ? WHERE id = ? AND state = 'QUEUED' AND generation = ?").bind(gen, leaseId, at, t.id, t.generation),
      db.prepare("INSERT INTO leases (id, task_id, device_id, generation, reward_units, nonce, issued_at, expires_at, state) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'LEASED' WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND current_lease_id = ?)")
        .bind(leaseId, t.id, deviceId, gen, t.reward_units, nonce, at, expiresAt, t.id, leaseId),
      db.prepare("UPDATE orders SET state = 'RUNNING' WHERE id = ? AND state = 'FUNDED'").bind(t.order_id),
    ]);
    if ((upd?.meta.changes ?? 0) !== 1) continue; // another device won this task
    const body = {
      protocol_version: PROTOCOL_VERSION,
      order_id: t.order_id,
      task_id: t.id,
      lease_id: leaseId,
      device_key_id: deviceId,
      profile_id: t.profile_id,
      input_manifest_digest: t.input_digest,
      record_count: t.record_count,
      max_tokens: 256,
      reward_asset: `eip155:${env.CHAIN_ID}/erc20:${env.USDC_ADDRESS}`,
      reward_units: String(t.reward_units),
      issued_at: at,
      expires_at: expiresAt,
      nonce,
    };
    return { kind: "lease", envelope: { ...body, coordinator_signature: await signEnvelope(env, body) } };
  }
  return { kind: "none", reason: "WAITING_FOR_WORK" };
}

/** What the device signs for a result: everything except the outputs themselves, which the digest binds. */
export const resultSigningPayload = (r: Pick<ResultEnvelope, "lease_id" | "output_digest" | "completed_record_count" | "execution_status" | "profile_id">) =>
  canonicalJson({ lease_id: r.lease_id, output_digest: r.output_digest, completed_record_count: r.completed_record_count, execution_status: r.execution_status, profile_id: r.profile_id });

export interface SubmitOutcome { status: number; body: Record<string, unknown>; enqueue: boolean }

/** §8.2 submission: on-time, fenced, idempotent by lease ID and output digest. */
export async function submitResult(env: Env, deviceId: string, leaseId: string, env_: ResultEnvelope, at: number): Promise<SubmitOutcome> {
  const db = env.DB;
  const lease = await db.prepare("SELECT * FROM leases WHERE id = ?").bind(leaseId).first<LeaseRow>();
  if (!lease || lease.device_id !== deviceId) throw new ApiError(404, "NOT_FOUND", "Lease not found");
  if (env_.lease_id !== leaseId) throw new ApiError(400, "LEASE_MISMATCH", "Envelope lease_id does not match the URL");
  const digest = await digestOf(env_.outputs);
  if (digest !== env_.output_digest) throw new ApiError(400, "DIGEST_MISMATCH", "output_digest does not match outputs");
  const dev = await db.prepare("SELECT public_key_jwk FROM devices WHERE id = ?").bind(deviceId).first<{ public_key_jwk: string }>();
  if (!dev || !(await verifyDeviceSig(JSON.parse(dev.public_key_jwk), resultSigningPayload(env_), env_.device_signature))) {
    throw new ApiError(400, "INVALID_SIGNATURE", "Result envelope signature did not match the device key");
  }

  if (lease.state !== "LEASED") {
    if (lease.output_digest && lease.output_digest === digest) {
      const rc = await db.prepare("SELECT id, decision, reason FROM receipts WHERE lease_id = ?").bind(leaseId).first();
      return { status: 200, body: { leaseId, state: lease.state, duplicate: true, receipt: rc ?? null }, enqueue: false };
    }
    if (lease.state === "EXPIRED") throw conflict("LEASE_EXPIRED", "The lease expired before a complete submission arrived");
    throw conflict("LEASE_CLOSED", `Lease is ${lease.state}; a different result was already recorded`);
  }

  if (env_.execution_status === "FAILED") {
    await db.batch([
      db.prepare("UPDATE leases SET state = 'RETURNED', reason = 'DEVICE_FAILED' WHERE id = ? AND state = 'LEASED'").bind(leaseId),
      db.prepare("UPDATE tasks SET state = CASE WHEN attempts >= 3 THEN 'FAILED' ELSE 'QUEUED' END, current_lease_id = NULL, updated_at = ? WHERE id = ? AND current_lease_id = ? AND state = 'LEASED'").bind(at, lease.task_id, leaseId),
    ]);
    return { status: 200, body: { leaseId, state: "RETURNED" }, enqueue: false };
  }
  if (at > lease.expires_at) {
    await sweep(env, at);
    throw conflict("LEASE_EXPIRED", "The lease expired before a complete submission arrived");
  }

  await env.BLOBS.put(`results/${leaseId}.json`, JSON.stringify({ profile_id: env_.profile_id, outputs: env_.outputs, submitted_at: at }));
  const [l] = await db.batch([
    db.prepare("UPDATE leases SET state = 'SUBMITTED', output_digest = ?, submitted_at = ? WHERE id = ? AND state = 'LEASED' AND expires_at >= ?").bind(digest, at, leaseId, at),
    db.prepare("UPDATE tasks SET state = 'SUBMITTED', updated_at = ? WHERE id = ? AND generation = ? AND current_lease_id = ? AND state = 'LEASED' AND EXISTS (SELECT 1 FROM leases WHERE id = ? AND state = 'SUBMITTED')")
      .bind(at, lease.task_id, lease.generation, leaseId, leaseId),
  ]);
  if ((l?.meta.changes ?? 0) !== 1) return submitResult(env, deviceId, leaseId, env_, at); // raced; re-evaluate idempotently
  return { status: 202, body: { leaseId, state: "SUBMITTED" }, enqueue: true };
}
