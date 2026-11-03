export default function SimChip({ kind = "Simulation", className = "" }: { kind?: "Simulation" | "Illustrative" | "Testnet" | "Candidate" | "Proposed"; className?: string }) {
  const styles: Record<string, string> = {
    Simulation: "bg-peach text-charcoal border-orange/40",
    Illustrative: "bg-peach text-charcoal border-orange/40",
    Proposed: "bg-paper text-charcoal border-charcoal/25",
    Candidate: "bg-paper text-charcoal border-charcoal/25",
    Testnet: "bg-charcoal text-paper border-charcoal",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ${styles[kind]} ${className}`}>
      <span aria-hidden="true">{kind === "Testnet" ? "◆" : "◇"}</span>
      {kind}
    </span>
  );
}
