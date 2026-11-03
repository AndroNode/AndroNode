import { digestOf, newId } from "@andronode/protocol/hash";
import { planTasks } from "@andronode/protocol/tasks";
import { ESCROW_TIMING } from "@andronode/protocol/params";
import type { Env } from "../env";
import { journal } from "./ledger";
import { emitEvent } from "./webhooks";

export interface StoredRecord { id: string; text: string; tokens: number }
export interface QuoteRow {
  id: string; account_id: string; profile_id: string; record_count: number; per_record_units: number; max_charge_units: number;
  records_digest: string; records_key: string; deadline_hours: number; quote_hash: string; order_id: string; expires_at: number; created_at: number;
}

export async function loadRecords(env: Env, key: string): Promise<StoredRecord[]> {
  const obj = await env.BLOBS.get(key);
  if (!obj) throw new Error(`Missing records blob ${key}`);
  return (await obj.json()) as StoredRecord[];
}

/**
 * Moves a QUOTED order to FUNDED and creates its tasks in one transaction.
 * Safe to call twice: the second call fails the unique (order_id, idx) constraint and changes nothing.
 */
export async function activateOrder(env: Env, orderId: string, opts: { mode: "chain" | "mock"; txHash?: string | null; fundedUnits: bigint; at: number }): Promise<boolean> {
  const db = env.DB;
  const row = await db.prepare("SELECT o.state, q.* FROM orders o JOIN quotes q ON q.id = o.quote_id WHERE o.id = ?").bind(orderId).first<QuoteRow & { state: string }>();
  if (!row || row.state !== "QUOTED") return false;
  if (opts.fundedUnits < BigInt(row.max_charge_units)) throw new Error("Funding below the quoted maximum");
  const records = await loadRecords(env, row.records_key);
  const plan = planTasks(records, BigInt(row.per_record_units));
  const deadline = Math.min(opts.at + row.deadline_hours * 3600_000, opts.at + ESCROW_TIMING.maxExecutionWindowMs);
  const hardClose = row.created_at + ESCROW_TIMING.hardCloseMs - 60_000;
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE orders SET state = 'FUNDED', funding_mode = ?, funding_tx = ?, funded_units = ?, funded_at = ?, deadline_at = ?, hard_close_at = ? WHERE id = ? AND state = 'QUOTED'")
      .bind(opts.mode, opts.txHash ?? null, Number(opts.fundedUnits), opts.at, deadline, hardClose, orderId),
  ];
  let start = 0;
  for (const t of plan) {
    const slice = records.slice(start, start + t.recordIds.length);
    const digest = await digestOf({ profile: row.profile_id, records: slice.map((r) => ({ id: r.id, text: r.text })) });
    stmts.push(
      db.prepare("INSERT INTO tasks (id, order_id, idx, record_start, record_count, charge_units, reward_units, input_digest, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)")
        .bind(newId("tsk"), orderId, t.index, start, t.recordIds.length, Number(t.charge), Number(t.reward), digest, opts.at),
    );
    start += t.recordIds.length;
  }
  stmts.push(...journal(db, `fund:${orderId}`, "Customer funded order escrow", [
    { account: "asset:escrow", units: opts.fundedUnits },
    { account: `liability:order:${orderId}`, units: -opts.fundedUnits },
  ], opts.at));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return false;
    throw e;
  }
  await emitEvent(env, row.account_id, "order.funded", { orderId, tasks: plan.length });
  return true;
}

const IN_FLIGHT = "('QUEUED','LEASED','SUBMITTED','VERIFYING')";

/** Expires overdue leases, fails queued work past order deadlines and closes finished orders. */
export async function sweep(env: Env, at: number, orderId: string | null = null): Promise<{ expired: number; finished: { id: string; state: string }[] }> {
  const db = env.DB;
  const [exp] = await db.batch([
    db.prepare("UPDATE leases SET state = 'EXPIRED' WHERE state = 'LEASED' AND expires_at < ?").bind(at),
    db.prepare(`UPDATE tasks SET current_lease_id = NULL, updated_at = ?1,
        state = CASE WHEN (SELECT state FROM orders o WHERE o.id = tasks.order_id) = 'CANCELLED' THEN 'CANCELLED'
                     WHEN attempts >= 3 OR (SELECT deadline_at FROM orders o WHERE o.id = tasks.order_id) <= ?1 THEN 'FAILED'
                     ELSE 'QUEUED' END
      WHERE state = 'LEASED' AND EXISTS (SELECT 1 FROM leases l WHERE l.id = tasks.current_lease_id AND l.state = 'EXPIRED')`).bind(at),
    db.prepare(`UPDATE tasks SET state = 'FAILED', updated_at = ?1
      WHERE state = 'QUEUED' AND EXISTS (SELECT 1 FROM orders o WHERE o.id = tasks.order_id AND o.deadline_at <= ?1)`).bind(at),
  ]);
  const fin = await db.prepare(`UPDATE orders SET finished_at = ?1,
        state = CASE WHEN state = 'CANCELLED' THEN 'CANCELLED' WHEN accepted_records = record_count THEN 'COMPLETED'
                     WHEN accepted_records = 0 THEN 'FAILED' ELSE 'PARTIAL' END
      WHERE state IN ('FUNDED','RUNNING','CANCELLED') AND finished_at IS NULL AND (?2 IS NULL OR id = ?2)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.order_id = orders.id AND t.state IN ${IN_FLIGHT})
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.order_id = orders.id)
      RETURNING id, state, account_id`).bind(at, orderId).all<{ id: string; state: string; account_id: string }>();
  for (const o of fin.results) await emitEvent(env, o.account_id, "order.finished", { orderId: o.id, state: o.state });
  return { expired: exp?.meta.changes ?? 0, finished: fin.results.map(({ id, state }) => ({ id, state })) };
}
