import { Hono } from "hono";
import { PILOT_CAPS, PRICING, PROBATION, LEASE_RULES } from "@andronode/protocol/params";
import type { AppEnv } from "../env";
import { coordinatorPublicKey } from "../lib/coordinator";
import { escrowConfigured, chainOf, isMainnet, publicClient } from "../lib/chain";
import { activeProfiles } from "../lib/profiles";
import { notFound } from "../lib/http";

export const pub = new Hono<AppEnv>();

pub.get("/health", async (c) => {
  const db = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>().catch(() => null);
  // ?chain=1 also checks that the Worker can reach the chain RPC (used to diagnose funding checks).
  let chain: { ok: boolean; head?: string; error?: string } | undefined;
  if (c.req.query("chain")) {
    const client = publicClient(c.env);
    if (!client) chain = { ok: false, error: "No RPC configured" };
    else chain = await client.getBlockNumber().then((h) => ({ ok: true, head: h.toString() }), (e: any) => ({ ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }));
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
