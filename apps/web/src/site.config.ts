import { siteConfigSchema, type SiteConfig } from "@andronode/protocol";

/**
 * The single source for project identity, chain and links (PRD FR-15).
 * Change values here only. Every label, link, modal and meta tag reads from this object.
 * Setting nativeTokenCa never enables payments or changes the live status.
 */
const raw: SiteConfig = {
  displayName: "AndroNode",
  tagline: "Everyday devices. Shared intelligence.",
  ticker: null,
  nativeTokenCa: null,
  nativeTokenCaOwnerConfirmed: false,
  chain: {
    id: 46630,
    name: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    verified: false,
  },
  settlement: {
    assetSymbol: "tUSDC",
    assetAddress: null,
    assetDecimals: 6,
    escrowAddress: null,
    adminSafe: null,
  },
  social: { x: null, support: null },
  docs: {
    whitepaperPdf: "/docs/AndroNode_Whitepaper_v1.pdf",
    whitepaperVersion: "1.0",
    whitepaperDate: "2 November 2026",
  },
  release: { status: "simulation", evidenceDate: null },
};

export const site = siteConfigSchema.parse(raw);
export default site;
