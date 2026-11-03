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
import { syncChain } from "./lib/settlement";

export const app = new Hono<AppEnv>();

app.use("/v1/*", secureHeaders());
app.use("/v1/*", async (c, next) => cors({ origin: c.env.SITE_ORIGIN, credentials: true, allowHeaders: ["content-type", "authorization", "x-an-device", "x-an-ts", "x-an-sig"] })(c, next));
app.use("/v1/*", async (c, next) => {
  await next();
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<VerifyJob | WebhookJob>, env: Env) {
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
    const at = Date.now();
    ctx.waitUntil((async () => {
      await sweep(env, at);
      await syncChain(env, at).catch((e) => console.error("chain sync failed", e));
      // Re-queue submissions stuck in Verifying (e.g. verifier outage). Timely submissions never expire (§16.2).
      const stuck = await env.DB.prepare("SELECT id FROM leases WHERE state IN ('SUBMITTED','VERIFYING') AND submitted_at < ? LIMIT 100").bind(at - 10 * 60_000).all<{ id: string }>();
      if (stuck.results.length) await env.VERIFY_QUEUE.sendBatch(stuck.results.map((r) => ({ body: { leaseId: r.id } })));
    })());
  },
} satisfies ExportedHandler<Env, VerifyJob | WebhookJob>;
