import { Hono } from "hono";
import { z } from "zod";
import { newId } from "@andronode/protocol/hash";
import { REVIEW_WINDOWS } from "@andronode/protocol/params";
import type { AppEnv } from "../env";
import { requireUser } from "../lib/auth";
import { claimableOnChain } from "../lib/chain";
import { body, conflict, notFound, now } from "../lib/http";
import { balance } from "../lib/ledger";

export const rewards = new Hono<AppEnv>();
rewards.use("*", requireUser);

/** §12.3: provisional, held, on-chain claimable and withdrawn are always shown separately. */
rewards.get("/", async (c) => {
  const u = c.get("user");
  const sums = await c.env.DB.prepare("SELECT state, COUNT(*) AS n, COALESCE(SUM(units),0) AS units FROM rewards WHERE account_id = ? GROUP BY state").bind(u.accountId).all<{ state: string; n: number; units: number }>();
  const get = (s: string) => sums.results.find((r) => r.state === s) ?? { n: 0, units: 0 };
  const onchain = await claimableOnChain(c.env, u.address).catch(() => null);
  const ledgerClaimable = -(await balance(c.env.DB, `liability:claimable:${u.accountId}`));
  const withdrawn = await c.env.DB.prepare("SELECT COALESCE(SUM(-p.units),0) AS s FROM postings p JOIN journals j ON j.id = p.journal_id WHERE j.event_key LIKE 'withdraw:%' AND p.account = ? ").bind(`liability:claimable:${u.accountId}`).first<{ s: number }>();
  const recent = await c.env.DB.prepare(`SELECT r.id, r.order_id, r.task_id, r.units, r.state, r.available_at, r.settlement_id, r.created_at, rc.id AS receipt_id
      FROM rewards r LEFT JOIN receipts rc ON rc.lease_id = r.lease_id WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT 100`).bind(u.accountId).all();
  const rejections = await c.env.DB.prepare(`SELECT rc.id, rc.task_id, rc.reason, rc.created_at FROM receipts rc JOIN devices d ON d.id = rc.device_id
      WHERE d.account_id = ? AND rc.decision = 'REJECTED' ORDER BY rc.created_at DESC LIMIT 50`).bind(u.accountId).all();
  return c.json({
    provisional: { units: String(get("PROVISIONAL").units), tasks: get("PROVISIONAL").n },
    held: { units: String(get("HELD").units), tasks: get("HELD").n },
    claimable: { units: String(onchain ?? ledgerClaimable), source: onchain === null ? "ledger" : "chain" },
    withdrawn: { units: String(withdrawn?.s ?? 0) },
    recent: recent.results,
    rejections: rejections.results,
  });
});

/** Contributor appeal of a rejection within seven days (§9.2). */
rewards.post("/appeals", async (c) => {
  const { receiptId, reason } = await body(c, z.object({ receiptId: z.string(), reason: z.string().min(10).max(2000) }));
  const rc = await c.env.DB.prepare("SELECT rc.created_at, rc.order_id FROM receipts rc JOIN devices d ON d.id = rc.device_id WHERE rc.id = ? AND d.account_id = ? AND rc.decision = 'REJECTED'").bind(receiptId, c.get("user").accountId).first<{ created_at: number; order_id: string }>();
  if (!rc) throw notFound("Rejected receipt");
  if (now() - rc.created_at > REVIEW_WINDOWS.contributorReviewMs) throw conflict("APPEAL_WINDOW_CLOSED", "Appeals must be filed within 7 days");
  const id = newId("dsp");
  await c.env.DB.prepare("INSERT INTO disputes (id, kind, account_id, order_id, receipt_id, reason, status, created_at) VALUES (?, 'contributor_appeal', ?, ?, ?, ?, 'open', ?)").bind(id, c.get("user").accountId, rc.order_id, receiptId, reason, now()).run();
  return c.json({ appealId: id, status: "open" }, 201);
});
