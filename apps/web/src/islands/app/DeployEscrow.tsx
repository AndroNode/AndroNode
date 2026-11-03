import { useState } from "react";
import { formatEther, getAddress, isAddress, type Hex } from "viem";
import { escrowAbi } from "@andronode/protocol/abi";
import { escrowBytecode } from "@andronode/protocol/escrow-bytecode";
import type { ApiConfig } from "../../lib/api";
import { copyText } from "../../lib/format";
import { walletOnChain } from "../../lib/wallet";
import { Button, Panel } from "../../components/ui";

/**
 * Deploys AndroNodeEscrow to Base Sepolia from the visitor's own browser wallet.
 * No private key ever leaves the wallet. Testnet only: the chain is fixed to 84532.
 * Mainnet deploys go through contracts/scripts/deploy.ts, which demands an audit commit.
 */
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CAP_UNITS = 500_000_000n; // 500 USDC outstanding escrow cap
const HARD_CLOSE = 1_209_600n; // 14 days
const EXPLORER = "https://sepolia.basescan.org";

type Step = "idle" | "connecting" | "ready" | "deploying" | "done" | "error";

export default function DeployEscrow() {
  const [step, setStep] = useState<Step>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [from, setFrom] = useState<Hex | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [admin, setAdmin] = useState("");
  const [treasury, setTreasury] = useState("");
  const [tx, setTx] = useState<Hex | null>(null);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const cfg = { chainId: CHAIN_ID } as ApiConfig;

  async function connect() {
    setStep("connecting");
    setMsg(null);
    try {
      const { publicClient, address } = await walletOnChain(cfg);
      setFrom(address);
      setAdmin((a) => a || address);
      setTreasury((t) => t || address);
      setBalance(await publicClient.getBalance({ address }));
      setStep("ready");
    } catch (e) {
      setStep("error");
      setMsg(e instanceof Error ? e.message.split("\n")[0]! : "Could not connect the wallet");
    }
  }

  async function deploy() {
    if (!isAddress(admin) || !isAddress(treasury)) return setMsg("Admin and treasury must both be valid addresses.");
    setStep("deploying");
    setMsg("Confirm the deploy in your wallet.");
    try {
      const { wallet, publicClient, address } = await walletOnChain(cfg);
      const hash = await wallet.deployContract({
        abi: escrowAbi,
        bytecode: escrowBytecode as Hex,
        account: address,
        args: [USDC, getAddress(admin), getAddress(treasury), CAP_UNITS, HARD_CLOSE],
      });
      setTx(hash);
      setMsg("Waiting for the transaction to be mined…");
      const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
      if (r.status !== "success" || !r.contractAddress) throw new Error("The deploy transaction reverted");
      setRecord({
        network: "baseSepolia",
        chainId: CHAIN_ID,
        escrow: r.contractAddress,
        asset: USDC,
        assetSymbol: "USDC",
        assetDecimals: 6,
        admin: getAddress(admin),
        operatorTreasury: getAddress(treasury),
        maxOutstandingEscrowUnits: CAP_UNITS.toString(),
        maxHardCloseWindowSeconds: Number(HARD_CLOSE),
        deployedAtBlock: r.blockNumber.toString(),
        deployedAt: new Date().toISOString(),
        deployer: address,
        txHash: hash,
      });
      setStep("done");
      setMsg(null);
    } catch (e) {
      setStep("error");
      setMsg(e instanceof Error ? e.message.split("\n")[0]! : "Deploy failed");
    }
  }

  const low = balance !== null && balance < 300_000_000_000_000n; // under 0.0003 ETH
  const json = record ? JSON.stringify(record, null, 2) : "";

  return (
    <div className="grid gap-6 pb-16 lg:grid-cols-[1fr_20rem]">
      <Panel title="Deploy the escrow contract" chip={<span className="rounded-full bg-peach px-2 py-0.5 font-mono text-xs">Base Sepolia only</span>} className="min-w-0">
        <ol className="space-y-5 text-sm">
          <li>
            <p className="font-bold">1. Connect the deployer wallet</p>
            {from ? (
              <p className="mt-1 break-all font-mono text-xs">{from} · {balance !== null ? `${formatEther(balance)} ETH` : "…"}</p>
            ) : (
              <div className="mt-2"><Button onClick={connect} disabled={step === "connecting"}>{step === "connecting" ? "Connecting…" : "Connect wallet"}</Button></div>
            )}
            {low && <p className="mt-2 text-warn">This wallet needs Base Sepolia ETH for gas first. Use a faucet from the list on the right, then <button type="button" className="underline" onClick={connect}>check again</button>.</p>}
          </li>
          <li>
            <p className="font-bold">2. Check the roles</p>
            <label className="mt-2 block">
              <span className="text-charcoal-60">Admin (can pause, settle and change limits). Use a Safe on mainnet.</span>
              <input className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs" value={admin} onChange={(e) => setAdmin(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
            </label>
            <label className="mt-3 block">
              <span className="text-charcoal-60">Operator treasury (receives the service fee)</span>
              <input className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs" value={treasury} onChange={(e) => setTreasury(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
            </label>
            <p className="mt-2 text-xs text-charcoal-60">Asset: Circle test USDC <span className="font-mono">{USDC}</span> · escrow cap 500 USDC · hard-close window 14 days.</p>
          </li>
          <li>
            <p className="font-bold">3. Deploy</p>
            <div className="mt-2"><Button variant="accent" onClick={deploy} disabled={!from || low || step === "deploying" || step === "done"}>{step === "deploying" ? "Deploying…" : "Deploy AndroNodeEscrow"}</Button></div>
          </li>
        </ol>
        {msg && <p className={`mt-4 text-sm ${step === "error" ? "text-bad" : ""}`} role="status">{msg}</p>}
        {tx && <p className="mt-2 text-sm">Transaction: <a className="break-all font-mono text-xs underline" href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></p>}
        {record && (
          <div className="mt-5 rounded-lg bg-ok/10 p-4 text-sm">
            <p className="font-bold">Deployed at <a className="break-all font-mono underline" href={`${EXPLORER}/address/${record.escrow}`} target="_blank" rel="noreferrer">{String(record.escrow)}</a></p>
            <p className="mt-1">Send this address to the operator so the API can be pointed at it. The record below is what goes in <span className="font-mono">contracts/deployments/baseSepolia.json</span>.</p>
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-paper p-3 font-mono text-xs">{json}</pre>
            <div className="mt-2"><Button variant="ghost" onClick={() => copyText(json)}>Copy record</Button></div>
          </div>
        )}
      </Panel>
      <Panel title="Test funds">
        <ul className="space-y-3 text-sm">
          <li><a className="underline" href="https://portal.cdp.coinbase.com/products/faucet" target="_blank" rel="noreferrer">Coinbase CDP faucet</a> · Base Sepolia ETH</li>
          <li><a className="underline" href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">Alchemy faucet</a> · Base Sepolia ETH</li>
          <li><a className="underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle faucet</a> · test USDC, for funding orders after deploy</li>
        </ul>
        <p className="mt-4 text-xs text-charcoal-60">A deploy costs well under 0.001 ETH on Base Sepolia. Never use a wallet that holds real funds for testing.</p>
      </Panel>
    </div>
  );
}
