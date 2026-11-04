import { Hono } from "hono";
import { PILOT_CAPS, PRICING, PROBATION, LEASE_RULES } from "@andronode/protocol/params";
import type { AppEnv } from "../env";
import { coordinatorPublicKey } from "../lib/coordinator";
import { escrowConfigured, chainOf, isMainnet, publicClient, rpcProvider, rpcUrlOf } from "../lib/chain";
import { activeProfiles } from "../lib/profiles";
import { notFound } from "../lib/http";

export const pub = new Hono<AppEnv>();

pub.get("/health", async (c) => {
  const db = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>().catch(() => null);
  // ?chain=1 also checks that the Worker can reach the chain RPC (used to diagnose funding checks).
  let chain: { ok: boolean; provider: string; head?: string; error?: string } | undefined;
  if (c.req.query("chain")) {
    const client = publicClient(c.env);
    const provider = rpcProvider(c.env);
    const key = c.env.ALCHEMY_API_KEY;
    // Errors can echo the request URL, so the key is masked before anything is returned.
    const clean = (e: any) => { const m = String(e?.shortMessage ?? e?.message ?? e).slice(0, 200); return key ? m.split(key).join("***") : m; };
    if (!client) chain = { ok: false, provider, error: "No RPC configured" };
    else chain = await client.getBlockNumber().then((h) => ({ ok: true, provider, head: h.toString() }), (e: any) => ({ ok: false, provider, error: clean(e) }));
  }
  return c.json({ ok: !!db, network: c.env.NETWORK, time: Date.now(), ...(chain ? { chain } : {}) });
});

pub.get("/config", (c) =>
  c.json({
    network: c.env.NETWORK,
    chainId: Number(c.env.CHAIN_ID),
    chain: { name: chainOf(c.env).name, rpcUrl: chainOf(c.env).rpcUrls.default.http[0], explorerUrl: chainOf(c.env).blockExplorers?.default.url ?? null, testnet: !isMainnet(c.env) },
    settlementAsset: { symbol: c.env.ASSET_SYMBOL || "USDC", address: c.env.USDC_ADDRESS || null, decimals: 6, faucet: !isMainnet(c.env) && (c.env.ASSET_SYMBOL || "") === "tUSDC" },
    escrowAddress: escrowConfigured(c.env) ? c.env.ESCROW_ADDRESS : null,
    mockFunding: c.env.ALLOW_MOCK_FUNDING === "true" && !isMainnet(c.env),
    verifierMode: c.env.VERIFIER_MODE,
    pricing: { ratePer1kUnits: PRICING.illustrativeRatePer1kUnits.toString(), label: "Illustrative testnet rate" },
    caps: { unsettledExposureUnits: PILOT_CAPS.maxUnsettledExposureUnits.toString(), outstandingEscrowUnits: PILOT_CAPS.maxOutstandingEscrowUnits.toString(), probationDeviceUnits: PROBATION.deviceProvisionalCapUnits.toString() },
    lease: LEASE_RULES,
    reviewWindowSeconds: Number(c.env.REVIEW_WINDOW_SECONDS),
  }),
);

pub.get("/profiles", (c) => c.json({ profiles: activeProfiles(c.env) }));

pub.get("/coordinator-key", async (c) => c.json({ alg: "ES256", jwk: await coordinatorPublicKey(c.env) }));

/** Public receipt: opaque IDs and the decision only, never inputs or vectors (§11). */
pub.get("/receipts/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT id, task_id, order_id, decision, reason, stats_json, verifier, created_at FROM receipts WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!r) throw notFound("Receipt");
  return c.json({ receipt: { ...r, stats: r.stats_json ? JSON.parse(String(r.stats_json)) : null, stats_json: undefined } });
});

/**
 * Read-only JSON-RPC relay for the testnet app, so browsers use the coordinator's RPC (Alchemy when configured)
 * without ever seeing its key. Only read methods pass; signing and sending stay in the user's own wallet.
 */
const RPC_READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "net_version",
]);
type RpcReq = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

pub.post("/rpc", async (c) => {
  // Only this site's pages may use the relay from a browser, so other sites cannot spend the RPC quota.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.env.SITE_ORIGIN).origin) return c.json(rpcError(null, -32003, "Origin not allowed"), 403);
  const url = rpcUrlOf(c.env);
  if (!url) return c.json(rpcError(null, -32000, "No RPC configured"), 503);
  const raw = await c.req.text();
  if (raw.length > 32_000) return c.json(rpcError(null, -32600, "Request too large"), 413);
  let body: RpcReq | RpcReq[];
  try { body = JSON.parse(raw); } catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }
  const batch = Array.isArray(body) ? body : [body];
  if (!batch.length || batch.length > 20) return c.json(rpcError(null, -32600, "Send 1 to 20 calls per request"), 400);
  const bad = batch.find((r) => typeof r?.method !== "string" || !RPC_READ_METHODS.has(r.method));
  if (bad) return c.json(rpcError(bad?.id, -32601, `Method not allowed here: ${String(bad?.method)}. Send transactions from your wallet.`), 400);
  const clean = batch.map((r) => ({ jsonrpc: "2.0", id: r.id ?? null, method: r.method, params: Array.isArray(r.params) ? r.params : [] }));
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.isArray(body) ? clean : clean[0]) });
    return new Response(await res.text(), { status: res.ok ? 200 : 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return c.json(rpcError(null, -32000, "Upstream RPC unreachable"), 502);
  }
});
