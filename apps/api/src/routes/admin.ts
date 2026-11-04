import { Hono } from "hono";
import { encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { escrowAbi } from "@andronode/protocol/abi";
import { newId } from "@andronode/protocol/hash";
import { PILOT_CAPS } from "@andronode/protocol/params";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { escrowConfigured, publicClient, isMainnet } from "../lib/chain";
import { body, conflict, forbidden, notFound, now } from "../lib/http";
import { balance } from "../lib/ledger";
import { applySettlement, confirmSettlementTx, prepareSettlement, settlementTransaction, syncChain } from "../lib/settlement";
import { sweep } from "../lib/orders";

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

async function audit(c: any, action: string, target: string, detail?: unknown) {
  await c.env.DB.prepare("INSERT INTO audit_log (id, actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("aud"), c.get("user").address, action, target, detail ? JSON.stringify(detail) : null, now()).run();
}

admin.get("/overview", async (c) => {
  const db = c.env.DB;
  await sweep(c.env, now());
  const q = (sql: string) => db.prepare(sql).all();
  const [orders, tasks, devices, rewards, imbalance, disputes] = await Promise.all([
    q("SELECT state, COUNT(*) AS n, COALESCE(SUM(funded_units),0) AS funded FROM orders GROUP BY state"),
    q("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state"),
    q("SELECT status, COUNT(*) AS n FROM devices GROUP BY status"),
    q("SELECT state, COUNT(*) AS n, COALESCE(SUM(units),0) AS units FROM rewards GROUP BY state"),
    q("SELECT j.event_key, SUM(p.units) AS s FROM postings p JOIN journals j ON j.id = p.journal_id GROUP BY j.id HAVING s != 0 LIMIT 10"),
    db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status = 'open'").first<{ n: number }>(),
  ]);
  const escrowLedger = await balance(db, "asset:escrow");
  let escrowOnChain: string | null = null;
  const client = publicClient(c.env);
  if (client && escrowConfigured(c.env)) {
    escrowOnChain = String(await client.readContract({ address: c.env.USDC_ADDRESS as Hex, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [c.env.ESCROW_ADDRESS as Hex] }).catch(() => null));
  }
  const exposure = await db.prepare("SELECT (SELECT COALESCE(SUM(reward_units),0) FROM leases WHERE state IN ('LEASED','SUBMITTED','VERIFYING')) + (SELECT COALESCE(SUM(units),0) FROM rewards WHERE state IN ('PROVISIONAL','HELD')) AS s").first<{ s: number }>();
  return c.json({
    orders: orders.results, tasks: tasks.results, devices: devices.results, rewards: rewards.results, openDisputes: disputes?.n ?? 0,
    exposure: { unsettledUnits: String(exposure?.s ?? 0), capUnits: PILOT_CAPS.maxUnsettledExposureUnits.toString() },
    reconciliation: { unbalancedJournals: imbalance.results, escrowLedgerUnits: escrowLedger.toString(), escrowOnChainUnits: escrowOnChain, note: "Mock-funded orders appear in the ledger but not on-chain." },
  });
});

admin.get("/orders", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT o.*, a.address,
      (SELECT COUNT(*) FROM rewards r WHERE r.order_id = o.id AND r.state = 'PROVISIONAL' AND r.settlement_id IS NULL AND r.available_at <= ?1) AS settleable
    FROM orders o JOIN accounts a ON a.id = o.account_id ORDER BY o.created_at DESC LIMIT 200`).bind(now()).all();
  return c.json({ orders: rows.results });
});

admin.get("/settlements", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, order_id, manifest_hash, charge_units, contributor_units, recipient_count, status, tx_hash, created_at, confirmed_at FROM settlements ORDER BY created_at DESC LIMIT 200").all();
  return c.json({ settlements: rows.results });
});

admin.post("/settlements/prepare", async (c) => {
  const { orderId } = await body(c, z.object({ orderId: z.string() }));
  const chunks = await prepareSettlement(c.env, orderId, now());
  await audit(c, "settlement.prepare", orderId, { chunks: chunks.map((x) => x.settlementId) });
  return c.json({ chunks, note: "Send each safeTransaction from the escrow admin (wallet or Safe), then confirm with its transaction hash." }, 201);
});

// The escrow call for a proposed settlement, for sending from the admin wallet or the Safe.
admin.get("/settlements/:id/tx", async (c) => c.json(await settlementTransaction(c.env, c.req.param("id"))));

admin.post("/settlements/:id/confirm", async (c) => {
  const req = await body(c, z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), mock: z.boolean().optional() }));
  const id = c.req.param("id");
  let changed: boolean;
  if (req.mock) {
    if (c.env.ALLOW_MOCK_FUNDING !== "true" || isMainnet(c.env)) throw forbidden("Mock settlement is disabled on this network");
    changed = await applySettlement(c.env, id, null, now());
  } else if (req.txHash) {
    changed = await confirmSettlementTx(c.env, id, req.txHash as Hex, now());
  } else throw conflict("MISSING_TX", "Provide txHash (or mock on testnet)");
  await audit(c, "settlement.confirm", id, req);
  return c.json({ settlementId: id, confirmed: true, changed });
});

admin.post("/orders/:id/close", async (c) => {
  const o = await c.env.DB.prepare("SELECT id, finished_at, funding_mode FROM orders WHERE id = ?").bind(c.req.param("id")).first<{ id: string; finished_at: number | null; funding_mode: string }>();
  if (!o) throw notFound("Order");
  if (!o.finished_at) throw conflict("NOT_FINISHED", "Order still has work in flight");
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM rewards WHERE order_id = ? AND state != 'CLAIMABLE'").bind(o.id).first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) throw conflict("UNSETTLED", "Settle or resolve every accepted task before closing");
  await audit(c, "order.close", o.id);
  if (o.funding_mode === "mock") {
    await c.env.DB.prepare("UPDATE orders SET state = 'CLOSED' WHERE id = ?").bind(o.id).run();
    return c.json({ orderId: o.id, state: "CLOSED", safeTransaction: null });
  }
  return c.json({ orderId: o.id, safeTransaction: escrowConfigured(c.env) ? { to: c.env.ESCROW_ADDRESS, value: "0", data: encodeFunctionData({ abi: escrowAbi, functionName: "closeOrder", args: [o.id as Hex] }) } : null });
});

admin.get("/disputes", async (c) => {
  const rows = await c.env.DB.prepare("SELECT d.*, a.address FROM disputes d JOIN accounts a ON a.id = d.account_id ORDER BY d.status = 'open' DESC, d.created_at DESC LIMIT 200").all();
  return c.json({ disputes: rows.results });
});

admin.post("/disputes/:id/resolve", async (c) => {
  const { outcome, resolution } = await body(c, z.object({ outcome: z.enum(["upheld", "rejected"]), resolution: z.string().min(3).max(2000) }));
  const d = await c.env.DB.prepare("SELECT * FROM disputes WHERE id = ? AND status = 'open'").bind(c.req.param("id")).first<{ id: string; kind: string; order_id: string }>();
  if (!d) throw notFound("Open dispute");
  const stmts = [c.env.DB.prepare("UPDATE disputes SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?").bind(outcome, resolution, now(), d.id)];
  // A rejected customer dispute releases held rewards. An upheld one keeps them held for operator-funded remedy.
  if (d.kind === "customer_output" && outcome === "rejected") stmts.push(c.env.DB.prepare("UPDATE rewards SET state = 'PROVISIONAL' WHERE order_id = ? AND state = 'HELD'").bind(d.order_id));
  await c.env.DB.batch(stmts);
  await audit(c, "dispute.resolve", d.id, { outcome });
  return c.json({ id: d.id, status: outcome });
});

admin.post("/devices/:id/status", async (c) => {
  const { status } = await body(c, z.object({ status: z.enum(["probation", "active", "suspended"]) }));
  const r = await c.env.DB.prepare("UPDATE devices SET status = ? WHERE id = ? AND status != 'revoked'").bind(status, c.req.param("id")).run();
  if (!r.meta.changes) throw notFound("Device");
  await audit(c, "device.status", c.req.param("id"), { status });
  return c.json({ ok: true });
});

admin.get("/devices", async (c) => {
  const rows = await c.env.DB.prepare("SELECT d.id, d.form_factor, d.label, d.status, d.accepted_tasks, d.rejected_tasks, d.last_seen_at, a.address FROM devices d JOIN accounts a ON a.id = d.account_id ORDER BY d.created_at DESC LIMIT 500").all();
  return c.json({ devices: rows.results });
});

admin.post("/sync", async (c) => c.json({ sweep: await sweep(c.env, now()), chain: await syncChain(c.env, now()) }));

admin.get("/audit", async (c) => c.json({ entries: (await c.env.DB.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200").all()).results }));
