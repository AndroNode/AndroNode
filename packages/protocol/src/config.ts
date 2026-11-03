import { z } from "zod";
import { evmAddress } from "./schemas.js";

/**
 * One configuration source for project identity, chain and links (PRD FR-15).
 * The native-token CA is separate from the settlement asset and escrow addresses,
 * and setting it can never turn on payments or change live status (FR-15, FR-17).
 */
export const siteConfigSchema = z.object({
  displayName: z.string(),
  tagline: z.string(),
  ticker: z.string().nullable(),
  nativeTokenCa: evmAddress.nullable(),
  nativeTokenCaOwnerConfirmed: z.boolean(),
  chain: z.object({
    id: z.number().int(),
    name: z.string(),
    rpcUrl: z.string().url(),
    explorerUrl: z.string().url().nullable(),
    verified: z.boolean(),
  }),
  settlement: z.object({
    assetSymbol: z.string(),
    assetAddress: evmAddress.nullable(),
    assetDecimals: z.number().int(),
    escrowAddress: evmAddress.nullable(),
    adminSafe: evmAddress.nullable(),
  }),
  social: z.object({ x: z.string().url().nullable(), support: z.string().nullable() }),
  docs: z.object({ whitepaperPdf: z.string(), whitepaperVersion: z.string(), whitepaperDate: z.string() }),
  release: z.object({
    status: z.enum(["simulation", "testnet", "mainnet"]),
    evidenceDate: z.string().nullable(),
  }),
});
export type SiteConfig = z.infer<typeof siteConfigSchema>;

export const CA_UNSET_LABEL = "CA: Not announced";
export const CA_UNSET_TOOLTIP = "Contract address will be announced at launch";

export type CaState =
  | { kind: "unset"; label: string; tooltip: string; copyable: false }
  | { kind: "invalid"; label: string; tooltip: string; copyable: false }
  | { kind: "set"; label: string; tooltip: string; copyable: true; address: string; explorerHref: string | null };

export function caState(cfg: SiteConfig): CaState {
  if (cfg.nativeTokenCa === null) return { kind: "unset", label: CA_UNSET_LABEL, tooltip: CA_UNSET_TOOLTIP, copyable: false };
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.nativeTokenCa) || !cfg.nativeTokenCaOwnerConfirmed) {
    return { kind: "invalid", label: "CA: Configuration error", tooltip: "The configured contract address is invalid or not owner-confirmed", copyable: false };
  }
  const a = cfg.nativeTokenCa;
  return {
    kind: "set",
    label: `CA: ${a.slice(0, 6)}…${a.slice(-4)}`,
    tooltip: a,
    copyable: true,
    address: a,
    explorerHref: cfg.chain.verified && cfg.chain.explorerUrl ? `${cfg.chain.explorerUrl}/token/${a}` : null,
  };
}
