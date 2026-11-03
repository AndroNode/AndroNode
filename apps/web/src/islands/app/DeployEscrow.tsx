import { useState } from "react";
import { formatEther, getAddress, isAddress, type Hex } from "viem";
import { escrowAbi, testUsdcAbi } from "@andronode/protocol/abi";
import { escrowBytecode, testUsdcBytecode } from "@andronode/protocol/escrow-bytecode";
import type { ApiConfig } from "../../lib/api";
import { copyText } from "../../lib/format";
import { walletOnChain } from "../../lib/wallet";
import { Button, Panel } from "../../components/ui";

/**
 * Deploys TestUSDC (faucet token) and AndroNodeEscrow to Robinhood Chain Testnet from the visitor's own browser wallet.
 * Robinhood Chain Testnet has no official USDC, so the escrow settles in this valueless test token.
 * No private key ever leaves the wallet. Testnet only: the chain is fixed to 46630.
 * Mainnet deploys go through contracts/scripts/deploy.ts, which demands an audit commit.
 */
const CHAIN_ID = 46630;
const CAP_UNITS = 500_000_000n; // 500 tUSDC outstanding escrow cap
const HARD_CLOSE = 1_209_600n; // 14 days
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";

type Step = "idle" | "connecting" | "ready" | "deploying" | "done" | "error";

export default function DeployEscrow() {
  const [step, setStep] = useState<Step>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [from, setFrom] = useState<Hex | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [admin, setAdmin] = useState("");
  const [treasury, setTreasury] = useState("");
  const [existingToken, setExistingToken] = useState("");
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
    if (existingToken && !isAddress(existingToken)) return setMsg("The existing token address is not valid. Leave it empty to deploy a new test token.");
    setStep("deploying");
    try {
      const { wallet, publicClient, address } = await walletOnChain(cfg);
      let token: Hex;
      if (existingToken) token = getAddress(existingToken);
      else {
        setMsg("1/2 Confirm the test USDC token deploy in your wallet.");
        const th = await wallet.deployContract({ abi: testUsdcAbi, bytecode: testUsdcBytecode as Hex, account: address });
        setTx(th);
        const tr = await publicClient.waitForTransactionReceipt({ hash: th, confirmations: 2 });
        if (tr.status !== "success" || !tr.contractAddress) throw new Error("The token deploy transaction reverted");
        token = getAddress(tr.contractAddress);
        setExistingToken(token); // a retry reuses this token instead of deploying another
      }
      setMsg("2/2 Confirm the escrow deploy in your wallet.");
      const hash = await wallet.deployContract({
        abi: escrowAbi,
        bytecode: escrowBytecode as Hex,
        account: address,
        args: [token, getAddress(admin), getAddress(treasury), CAP_UNITS, HARD_CLOSE],
      });
      setTx(hash);
      setMsg("Waiting for the escrow transaction to be mined…");
      const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
      if (r.status !== "success" || !r.contractAddress) throw new Error("The escrow deploy transaction reverted");
      setRecord({
        network: "robinhoodTestnet",
        chainId: CHAIN_ID,
        escrow: r.contractAddress,
        asset: token,
        assetSymbol: "tUSDC",
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

  const low = balance !== null && balance < 100_000_000_000_000n; // under 0.0001 ETH
  const json = record ? JSON.stringify(record, null, 2) : "";

  return (
    <div className="grid gap-6 pb-16 lg:grid-cols-[1fr_20rem]">
      <Panel title="Deploy the escrow contract" chip={<span className="rounded-full bg-peach px-2 py-0.5 font-mono text-xs">Robinhood testnet only</span>} className="min-w-0">
        <ol className="space-y-5 text-sm">
          <li>
            <p className="font-bold">1. Connect the deployer wallet</p>
            {from ? (
              <p className="mt-1 break-all font-mono text-xs">{from} · {balance !== null ? `${formatEther(balance)} ETH` : "…"}</p>
            ) : (
              <div className="mt-2"><Button onClick={connect} disabled={step === "connecting"}>{step === "connecting" ? "Connecting…" : "Connect wallet"}</Button></div>
            )}
            {low && <p className="mt-2 text-warn">This wallet needs Robinhood Chain Testnet ETH for gas first. Use the faucet on the right, then <button type="button" className="underline" onClick={connect}>check again</button>.</p>}
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
            <label className="mt-3 block">
              <span className="text-charcoal-60">Existing test USDC token (optional). Leave empty to deploy a new one.</span>
              <input className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs" value={existingToken} onChange={(e) => setExistingToken(e.target.value.trim())} placeholder="0x… or empty" spellCheck={false} />
            </label>
            <p className="mt-2 text-xs text-charcoal-60">Robinhood Chain Testnet has no official USDC, so orders settle in AndroNode Test USDC (tUSDC, 6 decimals, free faucet, no value) · escrow cap 500 tUSDC · hard-close window 14 days.</p>
          </li>
          <li>
            <p className="font-bold">3. Deploy</p>
            <p className="mt-1 text-charcoal-60">{existingToken ? "One wallet confirmation: the escrow." : "Two wallet confirmations: the test token, then the escrow."}</p>
            <div className="mt-2"><Button variant="accent" onClick={deploy} disabled={!from || low || step === "deploying" || step === "done"}>{step === "deploying" ? "Deploying…" : "Deploy contracts"}</Button></div>
          </li>
        </ol>
        {msg && <p className={`mt-4 text-sm ${step === "error" ? "text-bad" : ""}`} role="status">{msg}</p>}
        {tx && <p className="mt-2 text-sm">Transaction: <a className="break-all font-mono text-xs underline" href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a></p>}
        {record && (
          <div className="mt-5 rounded-lg bg-ok/10 p-4 text-sm">
            <p className="font-bold">Deployed at <a className="break-all font-mono underline" href={`${EXPLORER}/address/${record.escrow}`} target="_blank" rel="noreferrer">{String(record.escrow)}</a></p>
            <p className="mt-1">Test USDC token: <a className="break-all font-mono underline" href={`${EXPLORER}/address/${record.asset}`} target="_blank" rel="noreferrer">{String(record.asset)}</a></p>
            <p className="mt-1">Send both addresses to the operator so the API can be pointed at them. The record below is what goes in <span className="font-mono">contracts/deployments/robinhoodTestnet.json</span>.</p>
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-paper p-3 font-mono text-xs">{json}</pre>
            <div className="mt-2"><Button variant="ghost" onClick={() => copyText(json)}>Copy record</Button></div>
          </div>
        )}
      </Panel>
      <Panel title="Test funds">
        <ul className="space-y-3 text-sm">
          <li><a className="underline" href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">Robinhood Chain faucet</a> · testnet ETH for gas</li>
          <li><a className="underline" href="https://www.alchemy.com/faucets/robinhood-testnet" target="_blank" rel="noreferrer">Alchemy faucet</a> · testnet ETH for gas</li>
          <li><a className="underline" href={EXPLORER} target="_blank" rel="noreferrer">Testnet explorer</a></li>
          <li>Test USDC: after deploy, anyone can claim 1,000 tUSDC a day with <span className="font-mono">Get test USDC</span> in the customer app.</li>
        </ul>
        <p className="mt-4 text-xs text-charcoal-60">Both deploys together cost a small fraction of testnet ETH. Never use a wallet that holds real funds for testing.</p>
      </Panel>
    </div>
  );
}
