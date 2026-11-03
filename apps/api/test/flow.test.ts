import { describe, expect, it } from "vitest";
import { canonicalJson } from "@andronode/protocol/hash";
import { fixtureEmbedding } from "@andronode/protocol/fixture-embed";
import { verifyLease } from "../src/jobs/verify";
import { E, buildResult, call, login, records, registerDevice } from "./helpers";

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function fundedOrder(token: string, n: number, prefix = "r") {
  const { data: p } = await call("/v1/profiles");
  const q = await call("/v1/quotes", { method: "POST", token, json: { profileId: p.profiles[0].id, records: records(n, prefix), acceptDataBoundary: true } });
  expect(q.status).toBe(201);
  const o = await call("/v1/orders", { method: "POST", token, json: { quoteId: q.data.quote.id, mockFunding: true } });
  expect(o.status).toBe(201);
  return { quote: q.data, order: o.data.order, profileId: p.profiles[0].id as string };
}

async function doTask(dev: Awaited<ReturnType<typeof registerDevice>>, opts: { corrupt?: boolean } = {}) {
  const acq = await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} });
  if (!acq.data.lease) return { acq, lease: null as any };
  const lease = acq.data.lease;
  const inp = await dev.call(`/v1/node/leases/${lease.lease_id}/input`);
  expect(inp.status).toBe(200);
  const outputs = inp.data.records.map((r: { id: string; text: string }) => ({ id: r.id, vector: fixtureEmbedding(r.text).map((x) => (opts.corrupt ? x + 0.01 : x)) }));
  const env = await buildResult(dev, lease.lease_id, lease.profile_id, outputs);
  const sub = await dev.call(`/v1/node/leases/${lease.lease_id}/result`, { method: "POST", json: env });
  return { acq, lease, sub, env, outputs };
}

describe("public API", () => {
  it("serves health, config and profiles", async () => {
    expect((await call("/v1/health")).data.ok).toBe(true);
    const cfg = await call("/v1/config");
    expect(cfg.data.chainId).toBe(84532);
    expect(cfg.data.mockFunding).toBe(true);
    expect((await call("/v1/profiles")).data.profiles[0].dimensions).toBe(384);
    expect((await call("/v1/nope")).status).toBe(404);
  });

  it("rejects bad sign-in attempts", async () => {
    const r = await call("/v1/auth/verify", { method: "POST", json: { message: "hello", signature: "0x00" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await call("/v1/orders")).status).toBe(401);
  });
});

describe("customer quotes", () => {
  it("prices records at 200 units each and rejects long text instead of truncating", async () => {
    const { token } = await login("customer");
    const { data: p } = await call("/v1/profiles");
    const ok = await call("/v1/quotes", { method: "POST", token, json: { profileId: p.profiles[0].id, records: records(70), acceptDataBoundary: true } });
    expect(ok.status).toBe(201);
    expect(ok.data.quote.maxChargeUnits).toBe("14000");
    expect(ok.data.funding.quoteHash).toMatch(/^0x[0-9a-f]{64}$/);
    const long = await call("/v1/quotes", { method: "POST", token, json: { profileId: p.profiles[0].id, records: [{ id: "x", text: "word ".repeat(400) }], acceptDataBoundary: true } });
    expect(long.status).toBe(422);
    expect(long.data.error.detail.issues[0].problem).toBe("TOO_LONG");
    const noConsent = await call("/v1/quotes", { method: "POST", token, json: { profileId: p.profiles[0].id, records: records(1) } });
    expect(noConsent.status).toBe(400);
  });
});

describe("end-to-end testnet flow", () => {
  it("leases, verifies, rejects, retries, settles and keeps the ledger balanced", async () => {
    const cust = await login("customer");
    const contrib = await login("contributor");
    const { order, profileId } = await fundedOrder(cust.token, 70);
    expect(order.state).toBe("FUNDED");

    const dev = await registerDevice(contrib.token);
    expect((await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} })).data.error.code).toBe("NO_SESSION");
    expect((await dev.call("/v1/node/sessions/start", { method: "POST", json: { minutes: 30 } })).status).toBe(201);

    // Task 1: honest result, accepted.
    const t1 = await doTask(dev);
    expect(t1.lease.record_count).toBe(64);
    expect(t1.lease.reward_units).toBe("9600");
    const { data: ck } = await call("/v1/coordinator-key");
    const pub = await crypto.subtle.importKey("jwk", ck.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const { coordinator_signature, ...unsigned } = t1.lease;
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(coordinator_signature), new TextEncoder().encode(canonicalJson(unsigned)))).toBe(true);
    expect(t1.sub!.status).toBe(202);
    // Duplicate submission returns the original state; a conflicting digest is refused.
    expect((await dev.call(`/v1/node/leases/${t1.lease.lease_id}/result`, { method: "POST", json: t1.env })).data.duplicate).toBe(true);
    const other = await buildResult(dev, t1.lease.lease_id, profileId, t1.outputs!.map((o: any) => ({ ...o, vector: o.vector.map((x: number) => -x) })));
    expect((await dev.call(`/v1/node/leases/${t1.lease.lease_id}/result`, { method: "POST", json: other })).status).toBe(409);
    expect(await verifyLease(E, t1.lease.lease_id)).toBe("ACCEPTED");
    expect(await verifyLease(E, t1.lease.lease_id)).toBe("SKIPPED");

    // Task 2: corrupted vectors are rejected, and the same device is not offered the retry.
    const t2 = await doTask(dev, { corrupt: true });
    expect(t2.lease.record_count).toBe(6);
    expect(await verifyLease(E, t2.lease.lease_id)).toBe("REJECTED");
    const lease2 = await dev.call(`/v1/node/leases/${t2.lease.lease_id}`);
    expect(lease2.data.receipt.reason).toBe("NUMERIC_MISMATCH");
    expect((await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} })).data.status).toBe("WAITING_FOR_WORK");

    // A second device retries it honestly.
    const dev2 = await registerDevice(contrib.token);
    await dev2.call("/v1/node/sessions/start", { method: "POST", json: { minutes: 30 } });
    const t3 = await doTask(dev2);
    expect(t3.lease.task_id).toBe(t2.lease.task_id);
    expect(await verifyLease(E, t3.lease.lease_id)).toBe("ACCEPTED");

    const o = await call(`/v1/orders/${order.id}`, { token: cust.token });
    expect(o.data.order.state).toBe("COMPLETED");
    expect(o.data.order.accepted_records).toBe(70);
    expect(o.data.order.charged_units).toBe(14000);

    const res = await call(`/v1/orders/${order.id}/results/0`, { token: cust.token });
    expect(res.data.results).toHaveLength(64);

    const r1 = await call("/v1/rewards", { token: contrib.token });
    expect(r1.data.provisional.units).toBe("10500"); // 75% of 14000
    expect(r1.data.rejections).toHaveLength(1);

    // Settlement: admin prepares a chunk, confirms it (mock on testnet), rewards become claimable.
    const adm = await login("admin");
    expect((await call("/v1/admin/overview", { token: contrib.token })).status).toBe(403);
    const prep = await call("/v1/admin/settlements/prepare", { method: "POST", token: adm.token, json: { orderId: order.id } });
    expect(prep.status).toBe(201);
    expect(prep.data.chunks[0].charge).toBe("14000");
    expect(prep.data.chunks[0].amounts).toEqual(["10500"]);
    const conf = await call(`/v1/admin/settlements/${prep.data.chunks[0].settlementId}/confirm`, { method: "POST", token: adm.token, json: { mock: true } });
    expect(conf.status).toBe(200);
    const r2 = await call("/v1/rewards", { token: contrib.token });
    expect(r2.data.provisional.units).toBe("0");
    expect(r2.data.claimable.units).toBe("10500");

    const ov = await call("/v1/admin/overview", { token: adm.token });
    expect(ov.data.reconciliation.unbalancedJournals).toEqual([]);
    expect(ov.data.reconciliation.escrowLedgerUnits).toBe("14000");
  });

  it("refuses late submissions, replays and work after stop", async () => {
    const cust = await login("customer");
    const contrib = await login("other");
    await fundedOrder(cust.token, 10, "late");
    const dev = await registerDevice(contrib.token);
    await dev.call("/v1/node/sessions/start", { method: "POST", json: {} });
    const acq = await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} });
    const lease = acq.data.lease;
    expect((await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} })).data.error.code).toBe("ACTIVE_LEASE");

    // Replaying the exact same signed request is refused.
    const me = await dev.call("/v1/node/me");
    expect(me.status).toBe(200);
    expect((await dev.call("/v1/node/me", { reuse: me.headers })).data.error.code).toBe("DEVICE_REPLAY");

    const inp = await dev.call(`/v1/node/leases/${lease.lease_id}/input`);
    await E.DB.prepare("UPDATE leases SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, lease.lease_id).run();
    const env = await buildResult(dev, lease.lease_id, lease.profile_id, inp.data.records.map((r: any) => ({ id: r.id, vector: fixtureEmbedding(r.text) })));
    const late = await dev.call(`/v1/node/leases/${lease.lease_id}/result`, { method: "POST", json: env });
    expect(late.status).toBe(409);
    expect(late.data.error.code).toBe("LEASE_EXPIRED");
    const task = await E.DB.prepare("SELECT state, attempts FROM tasks WHERE id = ?").bind(lease.task_id).first();
    expect(task.state).toBe("QUEUED");

    // Stop returns the active lease without penalty and blocks new leases.
    const again = await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} });
    expect(again.data.lease.task_id).toBe(lease.task_id);
    const stop = await dev.call("/v1/node/sessions/stop", { method: "POST", json: {} });
    expect(stop.data.returnedLeases).toEqual([again.data.lease.lease_id]);
    expect((await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} })).data.error.code).toBe("NO_SESSION");
    const t = await E.DB.prepare("SELECT state FROM tasks WHERE id = ?").bind(lease.task_id).first();
    expect(t.state).toBe("QUEUED");
  });

  it("keeps already-leased work payable after the customer cancels", async () => {
    const cust = await login("customer");
    const contrib = await login("contributor");
    const open = await call("/v1/orders", { token: cust.token });
    for (const o of open.data.orders) if (o.state === "FUNDED" || o.state === "RUNNING") await call(`/v1/orders/${o.id}/cancel`, { method: "POST", token: cust.token });
    const { order } = await fundedOrder(cust.token, 130, "cx");
    const dev = await registerDevice(contrib.token);
    await dev.call("/v1/node/sessions/start", { method: "POST", json: {} });
    const acq = await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} });
    const lease = acq.data.lease;
    expect(lease.order_id).toBe(order.id);
    const cancel = await call(`/v1/orders/${order.id}/cancel`, { method: "POST", token: cust.token });
    expect(cancel.data.outstandingTasks).toBe(1);
    const inp = await dev.call(`/v1/node/leases/${lease.lease_id}/input`);
    const env = await buildResult(dev, lease.lease_id, lease.profile_id, inp.data.records.map((r: any) => ({ id: r.id, vector: fixtureEmbedding(r.text) })));
    expect((await dev.call(`/v1/node/leases/${lease.lease_id}/result`, { method: "POST", json: env })).status).toBe(202);
    expect(await verifyLease(E, lease.lease_id)).toBe("ACCEPTED");
    const o = await call(`/v1/orders/${order.id}`, { token: cust.token });
    expect(o.data.order.state).toBe("CANCELLED");
    expect(o.data.order.accepted_records).toBe(64);
    expect((await dev.call("/v1/node/leases/acquire", { method: "POST", json: {} })).data.status).toBe("WAITING_FOR_WORK");
  });
});
