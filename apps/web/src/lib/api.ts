import { getItem, setItem, removeItem } from "./storage";

/** Testnet API client. Same origin in production; PUBLIC_API_BASE overrides for local development. */
const BASE = (import.meta.env.PUBLIC_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
const TOKEN_KEY = "an-session";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) {
    super(message);
  }
}

export const sessionToken = () => getItem(TOKEN_KEY, "session");
export const setSessionToken = (t: string | null) => (t ? setItem(TOKEN_KEY, t, "session") : removeItem(TOKEN_KEY, "session"));

export async function api<T = any>(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const tok = init.auth === false ? null : sessionToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, credentials: "include" });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the AndroNode API. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) setSessionToken(null);
    throw new ApiError(res.status, data?.error?.code ?? "HTTP_" + res.status, data?.error?.message ?? `Request failed (${res.status})`, data?.error?.detail);
  }
  return data as T;
}

export interface ApiConfig {
  network: string;
  chainId: number;
  chain?: { name: string; rpcUrl: string; explorerUrl: string | null; testnet: boolean };
  settlementAsset: { symbol: string; address: string | null; decimals: number; faucet?: boolean };
  escrowAddress: string | null;
  mockFunding: boolean;
  verifierMode: "fixture" | "container";
  pricing: { ratePer1kUnits: string; label: string };
  caps: Record<string, string>;
  reviewWindowSeconds: number;
}
