import { newId } from "@andronode/protocol/hash";
import { verifySubmission } from "@andronode/protocol/verify";
import { allocate } from "@andronode/protocol/money";
import { MAINNET_MIN_REVIEW_SECONDS, PROBATION } from "@andronode/protocol/params";
import type { Env } from "../env";
import { isMainnet } from "../lib/chain";
import { referenceVectors } from "../lib/embedder";
import { journal } from "../lib/ledger";
import { loadRecords, sweep } from "../lib/orders";
import type { LeaseRow, TaskRow } from "../lib/leasing";
import { emitEvent } from "../lib/webhooks";

/** Full reference verification of one submitted lease (§9.1). Idempotent: re-running after a crash is safe. */
export async function verifyLease(env: Env, leaseId: string, at = Date.now()): Promise<"ACCEPTED" | "REJECTED" | "SKIPPED"> {
  const db = env.DB;
  const lease = await db.prepare("SELECT * FROM leases WHERE id = ?").bind(leaseId).first<LeaseRow>();
  if (!lease || (lease.state !== "SUBMITTED" && lease.state !== "VERIFYING")) return "SKIPPED";
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(lease.task_id).first<TaskRow>();
  const ctx = await db.prepare("SELECT o.account_id AS customer, o.id AS order_id, q.profile_id, q.records_key FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.id = ?").bind(task!.order_id).first<{ customer: string; order_id: string; profile_id: string; records_key: string }>();
  const dev = await db.prepare("SELECT account_id, status, accepted_tasks, created_at FROM devices WHERE id = ?").bind(lease.device_id).first<{ account_id: string; status: string; accepted_tasks: number; created_at: number }>();
  if (!task || !ctx || !dev) return "SKIPPED";

  await db.batch([
    db.prepare("UPDATE leases SET state = 'VERIFYING' WHERE id = ? AND state = 'SUBMITTED'").bind(leaseId),
    db.prepare("UPDATE tasks SET state = 'VERIFYING', updated_at = ? WHERE id = ? AND state = 'SUBMITTED' AND current_lease_id = ?").bind(at, task.id, leaseId),
  ]);

  const records = (await loadRecords(env, ctx.records_key)).slice(task.record_start, task.record_start + task.record_count);
  const blob = await env.BLOBS.get(`results/${leaseId}.json`);
  const sub = (await blob!.json()) as { profile_id: string; outputs: { id: string; vector: number[] }[] };
  const ref = await referenceVectors(env, records.map((r) => r.text));
  const report = verifySubmission({
    expectedRecordIds: records.map((r) => r.id),
    expectedProfileId: ctx.profile_id,
    submittedProfileId: sub.profile_id,
    submittedRecordIds: sub.outputs.map((o) => o.id),
    submittedVectors: sub.outputs.map((o) => o.vector),
    referenceVectors: ref.vectors,
    submittedAt: lease.submitted_at ?? 0,
    leaseExpiresAt: lease.expires_at,
    signatureValid: true, // checked when the envelope was accepted
  });
  const receiptId = newId("rcpt");
  const receipt = db.prepare("INSERT INTO receipts (id, lease_id, task_id, order_id, device_id, decision, reason, checks_json, stats_json, verifier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lease_id) DO NOTHING")
    .bind(receiptId, leaseId, task.id, ctx.order_id, lease.device_id, report.decision, report.reason, JSON.stringify(report.checks), report.worst ? JSON.stringify(report.worst) : null, ref.verifier, at);

  if (report.decision === "ACCEPTED") {
    const alloc = allocate(BigInt(task.charge_units));
    // Testnet can use a short review window; mainnet never goes below the 48-hour design minimum.
    const review = Math.max(Number(env.REVIEW_WINDOW_SECONDS) || 0, isMainnet(env) ? MAINNET_MIN_REVIEW_SECONDS : 0) * 1000;
    const graduate = dev.status === "probation" && dev.accepted_tasks + 1 >= PROBATION.tasksToGraduate && at - dev.created_at >= PROBATION.cleanDaysToGraduate * 86400_000;
    try {
      await db.batch([
        receipt,
        db.prepare("UPDATE leases SET state = 'ACCEPTED', verified_at = ? WHERE id = ? AND state = 'VERIFYING'").bind(at, leaseId),
        db.prepare("UPDATE tasks SET state = 'ACCEPTED', accepted_lease_id = ?, updated_at = ? WHERE id = ? AND accepted_lease_id IS NULL").bind(leaseId, at, task.id),
        db.prepare("INSERT INTO rewards (id, lease_id, task_id, order_id, device_id, account_id, charge_units, units, state, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROVISIONAL', ?, ?)")
          .bind(newId("rwd"), leaseId, task.id, ctx.order_id, lease.device_id, dev.account_id, task.charge_units, Number(alloc.contributor), at + review, at),
        db.prepare("UPDATE orders SET accepted_records = accepted_records + ?, charged_units = charged_units + ? WHERE id = ?").bind(task.record_count, task.charge_units, ctx.order_id),
        db.prepare(`UPDATE devices SET accepted_tasks = accepted_tasks + 1${graduate ? ", status = 'active'" : ""} WHERE id = ?`).bind(lease.device_id),
        ...journal(db, `accept:${task.id}`, "Accepted task: 75/25 allocation", [
          { account: `liability:order:${ctx.order_id}`, units: alloc.charge },
          { account: `liability:payable:${dev.account_id}`, units: -alloc.contributor },
          { account: "revenue:service", units: -alloc.service },
        ], at),
      ]);
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e; // already accepted: one primary payment per task
    }
  } else {
    await db.batch([
      receipt,
      db.prepare("UPDATE leases SET state = 'REJECTED', reason = ?, verified_at = ? WHERE id = ? AND state = 'VERIFYING'").bind(report.reason, at, leaseId),
      db.prepare(`UPDATE tasks SET current_lease_id = NULL, updated_at = ?,
          state = CASE WHEN (SELECT state FROM orders WHERE id = tasks.order_id) = 'CANCELLED' THEN 'CANCELLED' WHEN attempts >= 3 THEN 'FAILED' ELSE 'QUEUED' END
        WHERE id = ? AND current_lease_id = ? AND state = 'VERIFYING'`).bind(at, task.id, leaseId),
      db.prepare("UPDATE devices SET rejected_tasks = rejected_tasks + 1 WHERE id = ?").bind(lease.device_id),
    ]);
  }
  await sweep(env, at, ctx.order_id);
  await emitEvent(env, ctx.customer, "task.verified", { orderId: ctx.order_id, taskId: task.id, decision: report.decision });
  return report.decision;
}
