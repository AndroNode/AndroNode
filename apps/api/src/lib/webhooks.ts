import { newId } from "@andronode/protocol/hash";
import type { Env, WebhookJob } from "../env";
import { b64url } from "./http";

export async function emitEvent(env: Env, accountId: string, event: string, payload: unknown): Promise<void> {
  const hooks = await env.DB.prepare("SELECT id FROM webhooks WHERE account_id = ? AND disabled_at IS NULL").bind(accountId).all<{ id: string }>();
  if (!hooks.results.length) return;
  const eventId = newId("evt");
  await env.WEBHOOK_QUEUE.sendBatch(hooks.results.map((h) => ({ body: { webhookId: h.id, event, eventId, payload } satisfies WebhookJob })));
}

export async function signWebhook(secret: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
}

export async function deliverWebhook(env: Env, job: WebhookJob, attempt: number): Promise<boolean> {
  const hook = await env.DB.prepare("SELECT url, secret FROM webhooks WHERE id = ? AND disabled_at IS NULL").bind(job.webhookId).first<{ url: string; secret: string }>();
  if (!hook) return true;
  const ts = String(Date.now());
  const body = JSON.stringify({ id: job.eventId, type: job.event, data: job.payload });
  const res = await fetch(hook.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-an-event-id": job.eventId, "x-an-timestamp": ts, "x-an-retry": String(attempt), "x-an-signature": await signWebhook(hook.secret, ts, body) },
    body,
  }).catch(() => null);
  return !!res && res.ok;
}
