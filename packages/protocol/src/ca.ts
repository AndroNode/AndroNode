import type { SiteConfig } from "./config.js";

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
