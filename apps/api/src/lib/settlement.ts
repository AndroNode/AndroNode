import { encodeFunctionData, keccak256, parseEventLogs, toBytes, type Hex } from "viem";
import { escrowAbi } from "@andronode/protocol/abi";
import { canonicalJson, newId } from "@andronode/protocol/hash";
import { ESCROW_TIMING } from "@andronode/protocol/params";
import type { Env } from "../env";
import { escrowConfigured, fetchEscrowLogs, publicClient } from "./chain";
import { ApiError, conflict } from "./http";
import { journal } from "./ledger";
import { activateOrder } from "./orders";

interface Eligible { id: string; task_id: string; lease_id: string; units: number; charge_units: number; address: string; account_id: string }

/** Groups review-cleared rewards of one order into settlement chunks of at most 100 recipients (§13.2). */
export async function prepareSettlement(env: Env, orderId: string, at: number) {
  const db = env.DB;
  const open = await db.prepare("SELECT 1 FROM disputes WHERE order_id = ? AND status = 'open' AND kind = 'customer_output'").bind(orderId).first();
  if (open) throw conflict("DISPUTE_OPEN", "An open customer dispute blocks settlement for this order");
  const rows = await db.prepare(`SELECT r.id, r.task_id, r.lease_id, r.units, r.charge_units, a.address, r.account_id FROM rewards r JOIN accounts a ON a.id = r.account_id
      WHERE r.order_id = ? AND r.state = 'PROVISIONAL' AND r.settlement_id IS NULL AND r.available_at <= ? ORDER BY a.address, r.id`).bind(orderId, at).all<Eligible>();
  if (!rows.results.length) throw new ApiError(409, "NOTHING_TO_SETTLE", "No rewards for this order have cleared the review window");

  const byRecipient = new Map<string, Eligible[]>();
  for (const r of rows.results) byRecipient.set(r.address, [...(byRecipient.get(r.address) ?? []), r]);
  const recipients = [...byRecipient.keys()];
  const out = [];
  for (let i = 0; i < recipients.length; i += ESCROW_TIMING.maxRecipientsPerChunk) {
    const chunk = recipients.slice(i, i + ESCROW_TIMING.maxRecipientsPerChunk);
    const items = chunk.flatMap((a) => byRecipient.get(a)!);
    const amounts = chunk.map((a) => byRecipient.get(a)!.reduce((s, r) => s + BigInt(r.units), 0n));
    const charge = items.reduce((s, r) => s + BigInt(r.charge_units), 0n);
    const contributor = amounts.reduce((s, x) => s + x, 0n);
    if (charge % 4n !== 0n || contributor * 4n !== charge * 3n) throw new Error("Settlement chunk violates the 75/25 rule");
    const settlementId = keccak256(toBytes(`${orderId}:${newId("stl", 16)}`));
    const manifest = { orderId, settlementId, charge: charge.toString(), rewards: items.map((r) => ({ rewardId: r.id, taskId: r.task_id, leaseId: r.lease_id, recipient: r.address, units: String(r.units) })) };
    const manifestHash = keccak256(toBytes(canonicalJson(manifest)));
    const ids = items.map((r) => r.id);
    await db.batch([
      db.prepare("INSERT INTO settlements (id, order_id, manifest_hash, manifest_json, charge_units, contributor_units, recipient_count, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)")
        .bind(settlementId, orderId, manifestHash, JSON.stringify(manifest), Number(charge), Number(contributor), chunk.length, at),
      db.prepare(`UPDATE rewards SET settlement_id = ? WHERE settlement_id IS NULL AND id IN (${ids.map(() => "?").join(",")})`).bind(settlementId, ...ids),
    ]);
    const args = [orderId as Hex, settlementId, manifestHash, charge, chunk as Hex[], amounts] as const;
    out.push({
      settlementId, manifestHash, charge: charge.toString(), contributor: contributor.toString(), recipients: chunk, amounts: amounts.map(String),
      safeTransaction: escrowConfigured(env) ? { to: env.ESCROW_ADDRESS, value: "0", data: encodeFunctionData({ abi: escrowAbi, functionName: "settleChunk", args }) } : null,
    });
  }
  return out;
}

/** Marks a settlement confirmed on-chain and moves its rewards to Claimable. Idempotent. */
export async function applySettlement(env: Env, settlementId: string, txHash: string | null, at: number) {
  const db = env.DB;
  const s = await db.prepare("SELECT * FROM settlements WHERE id = ?").bind(settlementId).first<{ id: string; status: string; order_id: string; manifest_json: string }>();
  if (!s) throw new ApiError(404, "NOT_FOUND", "Settlement not found");
  if (s.status === "confirmed") return false;
  const manifest = JSON.parse(s.manifest_json) as { rewards: { recipient: string; units: string }[] };
  const rewards = await db.prepare("SELECT account_id, SUM(units) AS u FROM rewards WHERE settlement_id = ? GROUP BY account_id").bind(settlementId).all<{ account_id: string; u: number }>();
  const total = manifest.rewards.reduce((x, r) => x + BigInt(r.units), 0n);
  await db.batch([
    db.prepare("UPDATE settlements SET status = 'confirmed', tx_hash = ?, confirmed_at = ? WHERE id = ? AND status = 'proposed'").bind(txHash, at, settlementId),
    db.prepare("UPDATE rewards SET state = 'CLAIMABLE' WHERE settlement_id = ? AND state = 'PROVISIONAL'").bind(settlementId),
    ...journal(db, `settle:${settlementId}`, "Settlement credited on-chain", rewards.results.flatMap((r) => [
      { account: `liability:payable:${r.account_id}`, units: BigInt(r.u) },
      { account: `liability:claimable:${r.account_id}`, units: -BigInt(r.u) },
    ]), at),
  ]);
  return total > 0n;
}

/** Confirms a settlement from its transaction receipt (SettlementApplied with matching id and manifest). */
export async function confirmSettlementTx(env: Env, settlementId: string, txHash: Hex, at: number) {
  const client = publicClient(env);
  if (!client || !escrowConfigured(env)) throw new ApiError(409, "CHAIN_NOT_CONFIGURED", "No RPC or escrow address configured");
  const s = await env.DB.prepare("SELECT manifest_hash, charge_units FROM settlements WHERE id = ?").bind(settlementId).first<{ manifest_hash: string; charge_units: number }>();
  if (!s) throw new ApiError(404, "NOT_FOUND", "Settlement not found");
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const hit = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "SettlementApplied" }).find((l) => l.args.settlementId === settlementId && l.address.toLowerCase() === env.ESCROW_ADDRESS.toLowerCase());
  if (!hit || hit.args.manifestHash !== s.manifest_hash || hit.args.charge !== BigInt(s.charge_units)) throw new ApiError(409, "NO_MATCHING_EVENT", "Transaction did not apply this settlement");
  return applySettlement(env, settlementId, txHash, at);
}

/** Pulls confirmed escrow events and applies them to the ledger (funding, settlement, withdrawals, refunds). */
export async function syncChain(env: Env, at: number): Promise<{ processed: number; toBlock: string } | null> {
  const db = env.DB;
  const chainId = Number(env.CHAIN_ID);
  const cur = await db.prepare("SELECT last_block FROM chain_cursor WHERE chain_id = ?").bind(chainId).first<{ last_block: number }>();
  const client = publicClient(env);
  if (!client || !escrowConfigured(env)) return null;
  const from = cur ? BigInt(cur.last_block) + 1n : (await client.getBlockNumber()) - 5000n;
  const res = await fetchEscrowLogs(env, from);
  if (!res) return null;
  let processed = 0;
  for (const log of res.logs) {
    const fresh = await db.prepare("INSERT INTO chain_events (id, block_number, event, data_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(log.id, Number(log.blockNumber), log.eventName, JSON.stringify(log.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)), at).run();
    if (!fresh.meta.changes) continue;
    processed++;
    const a = log.args as Record<string, any>;
    if (log.eventName === "OrderFunded") {
      const q = await db.prepare("SELECT q.quote_hash, a.address FROM orders o JOIN quotes q ON q.id = o.quote_id JOIN accounts a ON a.id = o.account_id WHERE o.id = ?").bind(a.orderId).first<{ quote_hash: string; address: string }>();
      if (q && q.quote_hash === a.quoteHash && q.address === String(a.customer).toLowerCase()) await activateOrder(env, a.orderId, { mode: "chain", txHash: log.txHash, fundedUnits: BigInt(a.maxCharge), at });
    } else if (log.eventName === "SettlementApplied") {
      const s = await db.prepare("SELECT manifest_hash FROM settlements WHERE id = ?").bind(a.settlementId).first<{ manifest_hash: string }>();
      if (s && s.manifest_hash === a.manifestHash) await applySettlement(env, a.settlementId, log.txHash, at);
    } else if (log.eventName === "Withdrawn") {
      const acct = await db.prepare("SELECT id FROM accounts WHERE address = ?").bind(String(a.account).toLowerCase()).first<{ id: string }>();
      const who = acct ? `liability:claimable:${acct.id}` : `liability:claimable:${String(a.account).toLowerCase()}`;
      await db.batch(journal(db, `withdraw:${log.id}`, "Withdrawal from escrow", [{ account: who, units: BigInt(a.amount) }, { account: "asset:escrow", units: -BigInt(a.amount) }], at));
    } else if (log.eventName === "RemainderRefunded") {
      await db.batch([
        ...journal(db, `refund:${log.id}`, "Unallocated escrow refunded", [{ account: `liability:order:${a.orderId}`, units: BigInt(a.amount) }, { account: "asset:escrow", units: -BigInt(a.amount) }], at),
      ]);
    } else if (log.eventName === "OrderClosed") {
      await db.prepare("UPDATE orders SET state = 'CLOSED' WHERE id = ? AND finished_at IS NOT NULL").bind(a.orderId).run();
    }
  }
  await db.prepare("INSERT INTO chain_cursor (chain_id, last_block) VALUES (?, ?) ON CONFLICT(chain_id) DO UPDATE SET last_block = excluded.last_block").bind(chainId, Number(res.toBlock)).run();
  return { processed, toBlock: res.toBlock.toString() };
}
