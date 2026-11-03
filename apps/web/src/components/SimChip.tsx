export default function SimChip({ kind = "Simulation", className = "" }: { kind?: "Simulation" | "Illustrative" | "Testnet" | "Candidate" | "Proposed"; className?: string }) {
  const styles: Record<string, string> = {
    Simulation: "bg-orange/10 text-orange-deep border-orange/40",
    Illustrative: "bg-orange/10 text-orange-deep border-orange/40",
    Proposed: "bg-snow/5 text-snow border-snow/20",
    Candidate: "bg-snow/5 text-snow border-snow/20",
    Testnet: "bg-snow text-ink border-snow",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ${styles[kind]} ${className}`}>
      <span aria-hidden="true">{kind === "Testnet" ? "◆" : "◇"}</span>
      {kind}
    </span>
  );
}
