import { createPublicClient, encodeAbiParameters, http, keccak256, parseEventLogs, toBytes, type Hex, type PublicClient } from "viem";
import { base, baseSepolia, robinhood, robinhoodTestnet } from "viem/chains";
import { escrowAbi } from "@andronode/protocol/abi";
import type { Env } from "../env";

const CHAINS = { 46630: robinhoodTestnet, 4663: robinhood, 84532: baseSepolia, 8453: base } as const;
export const chainOf = (env: Env) => CHAINS[Number(env.CHAIN_ID) as keyof typeof CHAINS] ?? robinhoodTestnet;

/** Real-money networks. Mock funding, mock settlement and the fixture verifier are refused here. */
export const isMainnet = (env: Env) => env.NETWORK === "base" || env.NETWORK === "robinhood" || env.CHAIN_ID === "8453" || env.CHAIN_ID === "4663";

export function publicClient(env: Env): PublicClient | null {
  const url = env.RPC_URL || env.BASE_RPC_URL;
  if (!url) return null;
  return createPublicClient({ chain: chainOf(env), transport: http(url) }) as PublicClient;
}

export const escrowConfigured = (env: Env) => /^0x[0-9a-fA-F]{40}$/.test(env.ESCROW_ADDRESS);

/** Mirrors AndroNodeEscrow.orderIdFor: keccak256(abi.encode(chainid, escrow, customer, quoteHash)). */
export function orderIdFor(env: Env, customer: Hex, quoteHash: Hex): Hex {
  const escrow = (escrowConfigured(env) ? env.ESCROW_ADDRESS : "0x0000000000000000000000000000000000000000") as Hex;
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }], [BigInt(env.CHAIN_ID), escrow, customer, quoteHash]));
}

export const profileIdBytes32 = (profileId: string): Hex => keccak256(toBytes(profileId));

export interface FundingCheck { ok: boolean; reason?: string; amount?: bigint; blockNumber?: bigint }

/** Confirms a funding transaction emitted OrderFunded for exactly this order and quote. */
export async function checkFundingTx(env: Env, txHash: Hex, expect: { orderId: Hex; customer: string; quoteHash: Hex; maxCharge: bigint }): Promise<FundingCheck> {
  const client = publicClient(env);
  if (!client || !escrowConfigured(env)) return { ok: false, reason: "CHAIN_NOT_CONFIGURED" };
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) return { ok: false, reason: "TX_NOT_FOUND" };
  if (receipt.status !== "success") return { ok: false, reason: "TX_FAILED" };
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(env.CONFIRMATIONS)) return { ok: false, reason: "AWAITING_CONFIRMATIONS" };
  const logs = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "OrderFunded" }).filter((l) => l.address.toLowerCase() === env.ESCROW_ADDRESS.toLowerCase());
  const hit = logs.find((l) => l.args.orderId === expect.orderId);
  if (!hit) return { ok: false, reason: "NO_MATCHING_EVENT" };
  if (hit.args.customer.toLowerCase() !== expect.customer.toLowerCase() || hit.args.quoteHash !== expect.quoteHash || hit.args.maxCharge !== expect.maxCharge) {
    return { ok: false, reason: "EVENT_MISMATCH" };
  }
  return { ok: true, amount: hit.args.maxCharge, blockNumber: receipt.blockNumber };
}

export interface EscrowLog { id: string; blockNumber: bigint; eventName: string; args: Record<string, unknown>; txHash: Hex }

/** Reads escrow events in a bounded block range behind the confirmation depth. */
export async function fetchEscrowLogs(env: Env, fromBlock: bigint, maxSpan = 2000n): Promise<{ logs: EscrowLog[]; toBlock: bigint } | null> {
  const client = publicClient(env);
  if (!client || !escrowConfigured(env)) return null;
  const safeHead = (await client.getBlockNumber()) - BigInt(env.CONFIRMATIONS);
  if (safeHead < fromBlock) return { logs: [], toBlock: fromBlock - 1n };
  const toBlock = fromBlock + maxSpan - 1n < safeHead ? fromBlock + maxSpan - 1n : safeHead;
  const raw = await client.getLogs({ address: env.ESCROW_ADDRESS as Hex, fromBlock, toBlock });
  const parsed = parseEventLogs({ abi: escrowAbi, logs: raw });
  return {
    toBlock,
    logs: parsed.map((l) => ({ id: `${l.transactionHash}:${l.logIndex}`, blockNumber: l.blockNumber, eventName: l.eventName, args: l.args as Record<string, unknown>, txHash: l.transactionHash })),
  };
}

export async function claimableOnChain(env: Env, account: string): Promise<bigint | null> {
  const client = publicClient(env);
  if (!client || !escrowConfigured(env)) return null;
  return (await client.readContract({ address: env.ESCROW_ADDRESS as Hex, abi: escrowAbi, functionName: "claimable", args: [account as Hex] })) as bigint;
}
