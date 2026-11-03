import { Hono } from "hono";
import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import { canonicalJson, digestOf, newId, sha256Hex } from "@andronode/protocol/hash";
import { perRecordCharge } from "@andronode/protocol/money";
import { ESCROW_TIMING, PRICING, REVIEW_WINDOWS } from "@andronode/protocol/params";
import { orderCreateSchema, quoteRequestSchema, recordSchema } from "@andronode/protocol/schemas";
import { validateRecords } from "@andronode/protocol/tasks";
import type { AppEnv } from "../env";
import { requireUser } from "../lib/auth";
import { checkFundingTx, escrowConfigured, orderIdFor, profileIdBytes32, isMainnet } from "../lib/chain";
import { tokenCounts } from "../lib/embedder";
import { ApiError, bad, body, conflict, forbidden, notFound, now } from "../lib/http";
import { activateOrder, sweep, type QuoteRow } from "../lib/orders";
import { findProfile } from "../lib/profiles";

export const customer = new Hono<AppEnv>();
for (const p of ["/quotes", "/quotes/*", "/orders", "/orders/*", "/api-keys", "/api-keys/*", "/webhooks", "/webhooks/*"]) customer.use(p, requireUser);

const API_MAX_RECORDS = 10_000;
const QUOTE_TTL_MS = 15 * 60_000;

function fundingParams(c: { env: AppEnv["Bindings"] }, q: QuoteRow) {
  const hardCloseAt = Math.floor((q.created_at + ESCROW_TIMING.hardCloseMs - 60_000) / 1000);
  return {
    chainId: Number(c.env.CHAIN_ID),
    escrow: escrowConfigured(c.env) ? c.env.ESCROW_ADDRESS : null,
    asset: c.env.USDC_ADDRESS,
    maxCharge: String(q.max_charge_units),
    quoteHash: q.quote_hash,
    profileId: profileIdBytes32(q.profile_id),
    hardCloseAt,
    orderId: q.order_id,
    steps: ["approve(escrow, maxCharge) on the USDC contract", "fundOrder(maxCharge, quoteHash, profileId, hardCloseAt) on the escrow", "POST /v1/orders with quoteId and fundingTxHash"],
  };
}

customer.post("/quotes", async (c) => {
  const user = c.get("user");
  const req = await body(c, quoteRequestSchema.extend({ records: z.array(recordSchema).min(1).max(API_MAX_RECORDS) }));
  const profile = findProfile(c.env, req.profileId);
  if (!profile) throw bad("UNKNOWN_PROFILE", "Profile is not offered by this deployment");
  const counts = await tokenCounts(c.env, req.records.map((r) => r.text));
  const records = req.records.map((r, i) => ({ id: r.id, text: r.text, tokens: counts[i]! }));
  const issues = validateRecords(records, profile.maxTokensPerRecord);
  if (issues.length) throw new ApiError(422, "RECORDS_INVALID", "Some records cannot be processed. Long records are rejected, never truncated.", { issues: issues.slice(0, 200), total: issues.length });

  const perRecord = perRecordCharge(PRICING.illustrativeRatePer1kUnits);
  const maxCharge = perRecord * BigInt(records.length);
  const id = newId("qte");
  const at = now();
  const expiresAt = at + QUOTE_TTL_MS;
  const recordsDigest = await digestOf(records.map((r) => ({ id: r.id, text: r.text })));
  const quoteHash = keccak256(toBytes(canonicalJson({ v: 1, quoteId: id, chainId: c.env.CHAIN_ID, escrow: c.env.ESCROW_ADDRESS, customer: user.address, profileId: profile.id, recordsDigest, recordCount: records.length, perRecordUnits: perRecord, maxChargeUnits: maxCharge, deadlineHours: req.deadlineHours, expiresAt })));
  const orderId = orderIdFor(c.env, user.address as Hex, quoteHash);
  const key = `quotes/${id}.json`;
  await c.env.BLOBS.put(key, JSON.stringify(records));
  await c.env.DB.prepare("INSERT INTO quotes (id, account_id, profile_id, record_count, per_record_units, max_charge_units, records_digest, records_key, deadline_hours, quote_hash, order_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user.accountId, profile.id, records.length, Number(perRecord), Number(maxCharge), recordsDigest, key, req.deadlineHours, quoteHash, orderId, expiresAt, at).run();
  const q = (await c.env.DB.prepare("SELECT * FROM quotes WHERE id = ?").bind(id).first<QuoteRow>())!;
  return c.json({ quote: { id, profileId: profile.id, recordCount: records.length, perRecordUnits: String(perRecord), maxChargeUnits: String(maxCharge), expiresAt, rateLabel: "Illustrative testnet rate" }, funding: fundingParams(c, q) }, 201);
});

customer.get("/quotes/:id", async (c) => {
  const q = await c.env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND account_id = ?").bind(c.req.param("id"), c.get("user").accountId).first<QuoteRow>();
  if (!q) throw notFound("Quote");
  return c.json({ quote: q, funding: fundingParams(c, q) });
});

customer.post("/orders", async (c) => {
  const user = c.get("user");
  const req = await body(c, orderCreateSchema.extend({ mockFunding: z.boolean().optional() }));
  const q = await c.env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND account_id = ?").bind(req.quoteId, user.accountId).first<QuoteRow>();
  if (!q) throw notFound("Quote");
  const at = now();
  if (!req.fundingTxHash && q.expires_at < at) throw conflict("QUOTE_EXPIRED", "Quote expired. Request a new quote.");
  await c.env.DB.prepare("INSERT INTO orders (id, quote_id, account_id, state, funding_mode, record_count, created_at) VALUES (?, ?, ?, 'QUOTED', ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(q.order_id, q.id, user.accountId, req.mockFunding ? "mock" : "chain", q.record_count, at).run();

  let funding: { state: string; reason?: string } = { state: "AWAITING_FUNDING" };
  if (req.mockFunding) {
    if (c.env.ALLOW_MOCK_FUNDING !== "true" || isMainnet(c.env)) throw forbidden("Mock funding is disabled on this network");
    await activateOrder(c.env, q.order_id, { mode: "mock", fundedUnits: BigInt(q.max_charge_units), at });
    funding = { state: "FUNDED", reason: "MOCK" };
  } else if (req.fundingTxHash) {
    const chk = await checkFundingTx(c.env, req.fundingTxHash as Hex, { orderId: q.order_id as Hex, customer: user.address, quoteHash: q.quote_hash as Hex, maxCharge: BigInt(q.max_charge_units) });
    if (chk.ok) {
      await activateOrder(c.env, q.order_id, { mode: "chain", txHash: req.fundingTxHash, fundedUnits: chk.amount!, at });
      funding = { state: "FUNDED" };
    } else {
      // Keep the hash so the periodic job (and "Check funding") can confirm it later.
      await c.env.DB.prepare("UPDATE orders SET funding_tx = ? WHERE id = ? AND state = 'QUOTED'").bind(req.fundingTxHash, q.order_id).run();
      funding = { state: "AWAITING_FUNDING", reason: chk.reason, ...(chk.detail ? { detail: chk.detail } : {}) };
    }
  }
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(q.order_id).first();
  return c.json({ order, funding }, funding.state === "FUNDED" ? 201 : 202);
});

/** Re-checks an on-chain funding transaction for an order still in QUOTED, using the stored hash or a new one. */
customer.post("/orders/:id/check-funding", async (c) => {
  const user = c.get("user");
  const o = await ownOrder(c, c.req.param("id"));
  if (o.state !== "QUOTED") return c.json({ order: o, funding: { state: o.state === "CANCELLED" ? o.state : "FUNDED" } });
  const req = await body(c, z.object({ fundingTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }));
  const tx = (req.fundingTxHash ?? o.funding_tx) as Hex | null;
  if (!tx) throw bad("NO_FUNDING_TX", "Paste the funding transaction hash from your wallet or the explorer.");
  const q = await c.env.DB.prepare("SELECT * FROM quotes WHERE id = ?").bind(o.quote_id).first<QuoteRow>();
  const chk = await checkFundingTx(c.env, tx, { orderId: o.id as Hex, customer: user.address, quoteHash: q!.quote_hash as Hex, maxCharge: BigInt(q!.max_charge_units) });
  let funding: { state: string; reason?: string; detail?: string } = { state: "AWAITING_FUNDING", reason: chk.reason, detail: chk.detail };
  if (chk.ok) {
    await activateOrder(c.env, o.id, { mode: "chain", txHash: tx, fundedUnits: chk.amount!, at: now() });
    funding = { state: "FUNDED" };
  } else await c.env.DB.prepare("UPDATE orders SET funding_tx = ? WHERE id = ? AND state = 'QUOTED'").bind(tx, o.id).run();
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(o.id).first();
  return c.json({ order, funding });
});

customer.get("/orders", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 100").bind(c.get("user").accountId).all();
  return c.json({ orders: rows.results });
});

async function ownOrder(c: any, id: string) {
  const o = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ? AND account_id = ?").bind(id, c.get("user").accountId).first();
  if (!o) throw notFound("Order");
  return o as Record<string, any>;
}

customer.get("/orders/:id", async (c) => {
  await sweep(c.env, now(), c.req.param("id"));
  const o = await ownOrder(c, c.req.param("id"));
  const tasks = await c.env.DB.prepare("SELECT state, COUNT(*) AS n, SUM(record_count) AS records FROM tasks WHERE order_id = ? GROUP BY state").bind(o.id).all();
  const receipts = await c.env.DB.prepare("SELECT decision, reason, COUNT(*) AS n FROM receipts WHERE order_id = ? GROUP BY decision, reason").bind(o.id).all();
  const inflight = await c.env.DB.prepare("SELECT COALESCE(SUM(t.charge_units),0) AS s FROM tasks t WHERE t.order_id = ? AND t.state IN ('LEASED','SUBMITTED','VERIFYING')").bind(o.id).first<{ s: number }>();
  return c.json({ order: o, tasks: tasks.results, receipts: receipts.results, outstandingLiabilityUnits: String(inflight?.s ?? 0), refundableEstimateUnits: String(Math.max(0, Number(o.funded_units) - Number(o.charged_units) - (inflight?.s ?? 0))) });
});

/** §8.3: stops new leases; leased work stays payable if submitted on time and accepted. */
customer.post("/orders/:id/cancel", async (c) => {
  const o = await ownOrder(c, c.req.param("id"));
  if (!["FUNDED", "RUNNING", "QUOTED"].includes(o.state)) throw conflict("NOT_CANCELLABLE", `Order is ${o.state}`);
  const at = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE orders SET state = 'CANCELLED', cancelled_at = ?, finished_at = CASE WHEN state = 'QUOTED' THEN ? ELSE finished_at END WHERE id = ?").bind(at, at, o.id),
    c.env.DB.prepare("UPDATE tasks SET state = 'CANCELLED', updated_at = ? WHERE order_id = ? AND state = 'QUEUED'").bind(at, o.id),
  ]);
  await sweep(c.env, at, o.id);
  const inflight = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(charge_units),0) AS s FROM tasks WHERE order_id = ? AND state IN ('LEASED','SUBMITTED','VERIFYING')").bind(o.id).first<{ n: number; s: number }>();
  return c.json({ orderId: o.id, state: "CANCELLED", outstandingTasks: inflight?.n ?? 0, outstandingLiabilityUnits: String(inflight?.s ?? 0) });
});

customer.get("/orders/:id/results", async (c) => {
  const o = await ownOrder(c, c.req.param("id"));
  const rows = await c.env.DB.prepare("SELECT t.idx, t.record_count, t.state, r.id AS receipt_id FROM tasks t LEFT JOIN receipts r ON r.lease_id = t.accepted_lease_id WHERE t.order_id = ? ORDER BY t.idx").bind(o.id).all<{ idx: number; record_count: number; state: string; receipt_id: string | null }>();
  return c.json({ orderId: o.id, profileId: (await c.env.DB.prepare("SELECT profile_id FROM quotes WHERE id = ?").bind(o.quote_id).first<{ profile_id: string }>())?.profile_id, tasks: rows.results.map((t) => ({ ...t, download: t.state === "ACCEPTED" ? `/v1/orders/${o.id}/results/${t.idx}` : null })) });
});

customer.get("/orders/:id/results/:idx", async (c) => {
  const o = await ownOrder(c, c.req.param("id"));
  const t = await c.env.DB.prepare("SELECT t.*, r.id AS receipt_id FROM tasks t LEFT JOIN receipts r ON r.lease_id = t.accepted_lease_id WHERE t.order_id = ? AND t.idx = ? AND t.state = 'ACCEPTED'").bind(o.id, Number(c.req.param("idx"))).first<{ accepted_lease_id: string; receipt_id: string }>();
  if (!t) throw notFound("Accepted task");
  const blob = await c.env.BLOBS.get(`results/${t.accepted_lease_id}.json`);
  if (!blob) throw notFound("Result");
  const r = (await blob.json()) as { profile_id: string; outputs: { id: string; vector: number[] }[] };
  return c.json({ orderId: o.id, profileId: r.profile_id, receiptId: t.receipt_id, status: "ACCEPTED", results: r.outputs });
});

customer.post("/orders/:id/disputes", async (c) => {
  const o = await ownOrder(c, c.req.param("id"));
  const { reason } = await body(c, z.object({ reason: z.string().min(10).max(2000) }));
  if (!o.finished_at && o.state !== "RUNNING") throw conflict("NO_RESULTS", "Nothing to dispute yet");
  const latest = await c.env.DB.prepare("SELECT MAX(created_at) AS t FROM receipts WHERE order_id = ? AND decision = 'ACCEPTED'").bind(o.id).first<{ t: number | null }>();
  if (!latest?.t || now() - latest.t > REVIEW_WINDOWS.customerDisputeMs) throw conflict("DISPUTE_WINDOW_CLOSED", "Disputes must be opened within 48 hours of results");
  const id = newId("dsp");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO disputes (id, kind, account_id, order_id, reason, status, created_at) VALUES (?, 'customer_output', ?, ?, ?, 'open', ?)").bind(id, c.get("user").accountId, o.id, reason, now()),
    c.env.DB.prepare("UPDATE rewards SET state = 'HELD' WHERE order_id = ? AND state = 'PROVISIONAL' AND settlement_id IS NULL").bind(o.id),
  ]);
  return c.json({ disputeId: id, status: "open" }, 201);
});

customer.post("/api-keys", async (c) => {
  if (c.get("user").via !== "session") throw forbidden("Create API keys from a wallet session");
  const { label } = await body(c, z.object({ label: z.string().max(64).optional() }));
  const secret = "ank_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const id = newId("key");
  await c.env.DB.prepare("INSERT INTO api_keys (id, account_id, prefix, secret_hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, c.get("user").accountId, secret.slice(0, 10), await sha256Hex(secret), label ?? null, now()).run();
  return c.json({ id, key: secret, note: "Shown once. Store it securely." }, 201);
});

customer.get("/api-keys", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, prefix, label, created_at, revoked_at FROM api_keys WHERE account_id = ?").bind(c.get("user").accountId).all();
  return c.json({ keys: rows.results });
});

customer.delete("/api-keys/:id", async (c) => {
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ?").bind(now(), c.req.param("id"), c.get("user").accountId).run();
  return c.json({ ok: true });
});

customer.post("/webhooks", async (c) => {
  const { url } = await body(c, z.object({ url: z.string().url().refine((u) => u.startsWith("https://"), "Webhook URL must use https") }));
  const id = newId("whk");
  const secret = "whsec_" + crypto.randomUUID().replace(/-/g, "");
  await c.env.DB.prepare("INSERT INTO webhooks (id, account_id, url, secret, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, c.get("user").accountId, url, secret, now()).run();
  return c.json({ id, secret, note: "Verify x-an-signature = HMAC-SHA256(secret, timestamp + '.' + body), base64url." }, 201);
});
