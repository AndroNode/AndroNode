export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BLOBS: R2Bucket;
  KV: KVNamespace;
  VERIFY_QUEUE: Queue<VerifyJob>;
  WEBHOOK_QUEUE: Queue<WebhookJob>;
  NETWORK: "base-sepolia" | "base" | "local";
  CHAIN_ID: string;
  USDC_ADDRESS: string;
  ESCROW_ADDRESS: string;
  ADMIN_ADDRESSES: string;
  SITE_ORIGIN: string;
  VERIFIER_MODE: "fixture" | "container";
  ALLOW_MOCK_FUNDING: string;
  REVIEW_WINDOW_SECONDS: string;
  CONFIRMATIONS: string;
  SESSION_SECRET: string;
  COORDINATOR_KEY_JWK: string;
  BASE_RPC_URL?: string;
  VERIFIER_URL?: string;
  VERIFIER_TOKEN?: string;
}

export interface VerifyJob { leaseId: string }
export interface WebhookJob { webhookId: string; event: string; eventId: string; payload: unknown }

export interface AuthUser { accountId: string; address: string; isAdmin: boolean; via: "session" | "api_key" }
export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; deviceId: string } };
