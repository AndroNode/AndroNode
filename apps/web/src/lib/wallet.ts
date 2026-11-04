import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, custom, fallback, http, numberToHex, type EIP1193Provider, type Hex } from "viem";
import { base, baseSepolia, robinhood, robinhoodTestnet } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { api, BASE, setSessionToken, sessionToken, type ApiConfig } from "./api";

/** EIP-6963 wallet discovery with a window.ethereum fallback. No wallet SDK, no tracking. */
export interface WalletInfo { id: string; name: string; icon?: string; provider: EIP1193Provider }

export function discoverWallets(timeoutMs = 300): Promise<WalletInfo[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve([]);
    const found = new Map<string, WalletInfo>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
      found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const eth = (window as any).ethereum as EIP1193Provider | undefined;
      if (!found.size && eth) found.set("injected", { id: "injected", name: "Browser wallet", provider: eth });
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

const CHAINS = { 46630: robinhoodTestnet, 4663: robinhood, 84532: baseSepolia, 8453: base } as const;
export const chainFor = (id: number) => CHAINS[id as keyof typeof CHAINS] ?? robinhoodTestnet;

export interface Account { id: string; address: string; isAdmin: boolean }
interface SessionState { status: "loading" | "signed-out" | "signed-in"; account: Account | null; provider: EIP1193Provider | null; address: Hex | null }

let state: SessionState = { status: "loading", account: null, provider: null, address: null };
const subs = new Set<(s: SessionState) => void>();
const set = (p: Partial<SessionState>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f(state));
};

async function restore() {
  if (!sessionToken()) return set({ status: "signed-out" });
  try {
    const { account } = await api<{ account: { accountId: string; address: string; isAdmin: boolean } }>("/v1/auth/me");
    set({ status: "signed-in", account: { id: account.accountId, address: account.address, isAdmin: account.isAdmin } });
  } catch {
    set({ status: "signed-out", account: null });
  }
}
let restored = false;

export function useSession() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!restored) {
      restored = true;
      restore();
    } else setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}

/** Connects a wallet and signs in with Ethereum (EIP-4361). The signature costs no gas. */
export async function signIn(wallet: WalletInfo, cfg: ApiConfig): Promise<Account> {
  const chain = chainFor(cfg.chainId);
  const client = createWalletClient({ chain, transport: custom(wallet.provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error("No account selected in the wallet");
  const n = await api<{ nonce: string; chainId: number; domain: string; uri: string }>("/v1/auth/nonce", { method: "POST", auth: false });
  const message = createSiweMessage({ domain: n.domain, address, statement: "Sign in to the AndroNode testnet app. This does not send a transaction or cost gas.", uri: n.uri, version: "1", chainId: n.chainId, nonce: n.nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 10 * 60_000) });
  const signature = await client.signMessage({ account: address, message });
  const r = await api<{ token: string; account: Account }>("/v1/auth/verify", { json: { message, signature }, auth: false });
  setSessionToken(r.token);
  set({ status: "signed-in", account: r.account, provider: wallet.provider, address });
  return r.account;
}

export async function signOut() {
  await api("/v1/auth/logout", { method: "POST" }).catch(() => {});
  setSessionToken(null);
  set({ status: "signed-out", account: null, provider: null, address: null });
}

/** Returns a wallet client on the configured chain, asking the wallet to switch or add it if needed. */
export async function walletOnChain(cfg: ApiConfig) {
  let provider = state.provider;
  if (!provider) {
    const ws = await discoverWallets();
    provider = ws[0]?.provider ?? null;
    if (!provider) throw new Error("No browser wallet found");
    set({ provider });
  }
  const chain = chainFor(cfg.chainId);
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current !== chain.id) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
    } catch (e: any) {
      if (e?.code !== 4902) throw e;
      await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: numberToHex(chain.id), chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [chain.rpcUrls.default.http[0]!], blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [] }] });
    }
  }
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  // Reads go through the coordinator's relay (Alchemy when configured), falling back to the wallet's own RPC.
  const publicClient = createPublicClient({ chain, transport: fallback([relay(), custom(provider)]) });
  return { wallet, publicClient, address: address!, chain };
}

export const explorerTx = (cfg: ApiConfig, hash: string) => `${chainFor(cfg.chainId).blockExplorers?.default.url}/tx/${hash}`;
/** The coordinator's read-only RPC relay. Its upstream key (Alchemy) stays on the server. */
const relay = () => http(`${BASE || (typeof location !== "undefined" ? location.origin : "")}/v1/rpc`, { batch: { batchSize: 20 }, retryCount: 1 });
export const readClient = (cfg: ApiConfig) => createPublicClient({ chain: chainFor(cfg.chainId), transport: fallback([relay(), http()]) });
