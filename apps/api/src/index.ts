import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env, VerifyJob, WebhookJob } from "./env";
import { ApiError } from "./lib/http";
import { auth } from "./routes/auth";
import { pub } from "./routes/public";
import { customer } from "./routes/customer";
import { devices, node } from "./routes/devices";
import { rewards } from "./routes/rewards";
import { admin } from "./routes/admin";
import { verifyLease } from "./jobs/verify";
import { deliverWebhook } from "./lib/webhooks";
import { sweep } from "./lib/orders";
import { recheckPendingFunding, syncChain } from "./lib/settlement";
import { withBlobs } from "./lib/blobs";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  withBlobs(c.env);
  await next();
});

app.use("/v1/*", async (c, next) => {
  await next();
  try {
    c.executionCtx.waitUntil(runPeriodic(c.env, Date.now()).catch((e) => console.error("periodic run failed", e)));
  } catch {
    // No execution context (unit tests calling app.fetch directly).
  }
});

app.use("/v1/*", secureHeaders());
app.use("/v1/*", async (c, next) => cors({ origin: c.env.SITE_ORIGIN, credentials: true, allowHeaders: ["content-type", "authorization", "x-an-device", "x-an-ts", "x-an-sig"] })(c, next));
app.use("/v1/*", async (c, next) => {
  await next();
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
});

/** Per-IP rate limits: strict for sign-in, generous for other writes (device writes are keyed by device). */
app.use("/v1/*", async (c, next) => {
  if (c.req.method !== "GET") {
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const limiter = c.req.path.startsWith("/v1/auth/") ? c.env.RL_AUTH : c.env.RL_WRITE;
    const key = c.req.header("x-an-device") ?? ip;
    if (limiter && !(await limiter.limit({ key })).success) {
      return c.json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute and try again." } }, 429, { "retry-after": "60" });
    }
  }
  await next();
});

const v1 = new Hono<AppEnv>();
v1.route("/", pub);
v1.route("/auth", auth);
v1.route("/devices", devices);
v1.route("/node", node);
v1.route("/rewards", rewards);
v1.route("/admin", admin);
v1.route("/", customer);
app.route("/v1", v1);

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status as 400);
  console.error("unhandled", err);
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong. It has been logged." } }, 500);
});
app.notFound((c) => (c.req.path.startsWith("/v1/") ? c.json({ error: { code: "NOT_FOUND", message: "No such endpoint" } }, 404) : c.env.ASSETS.fetch(c.req.raw)));

/**
 * Sweep expired leases, sync the chain and re-queue stuck verifications. Runs from the cron trigger, and also
 * from ordinary API traffic at most once every 2 minutes, so it keeps working when the account has no free
 * cron slot (Workers Free allows 5 per account). The UPDATE is the claim: only one request wins each window.
 */
async function runPeriodic(env: Env, at: number, fromCron = false) {
  const claim = await env.DB.prepare("UPDATE job_runs SET last_at = ? WHERE name = 'periodic' AND last_at < ?").bind(at, at - (fromCron ? 60_000 : 120_000)).run();
  if (!claim.meta.changes) return;
  await sweep(env, at);
  await syncChain(env, at).catch((e) => console.error("chain sync failed", e));
  await recheckPendingFunding(env, at).catch((e) => console.error("funding recheck failed", e));
  // Re-queue submissions stuck in Verifying (e.g. verifier outage). Timely submissions never expire (§16.2).
  const stuck = await env.DB.prepare("SELECT id FROM leases WHERE state IN ('SUBMITTED','VERIFYING') AND submitted_at < ? LIMIT 100").bind(at - 10 * 60_000).all<{ id: string }>();
  if (stuck.results.length) await env.VERIFY_QUEUE.sendBatch(stuck.results.map((r) => ({ body: { leaseId: r.id } })));
  await env.DB.prepare("DELETE FROM device_replay WHERE expires_at < ?").bind(at).run();
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<VerifyJob | WebhookJob>, env: Env) {
    withBlobs(env);
    for (const msg of batch.messages) {
      try {
        if (batch.queue.includes("verify")) {
          await verifyLease(env, (msg.body as VerifyJob).leaseId);
          msg.ack();
        } else {
          const ok = await deliverWebhook(env, msg.body as WebhookJob, msg.attempts);
          if (ok) msg.ack();
          else msg.retry({ delaySeconds: Math.min(3600, 2 ** msg.attempts * 10) });
        }
      } catch (e) {
        console.error("queue job failed", batch.queue, e);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
  async scheduled(_ctl: ScheduledController, env: Env, ctx: ExecutionContext) {
    withBlobs(env);
    ctx.waitUntil(runPeriodic(env, Date.now(), true));
  },
} satisfies ExportedHandler<Env, VerifyJob | WebhookJob>;
