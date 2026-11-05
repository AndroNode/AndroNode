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
  social: z.object({ x: z.string().url().nullable(), github: z.string().url().nullable().default(null), support: z.string().nullable() }),
  release: z.object({
    status: z.enum(["simulation", "testnet", "mainnet"]),
    evidenceDate: z.string().nullable(),
  }),
});
export type SiteConfig = z.infer<typeof siteConfigSchema>;

