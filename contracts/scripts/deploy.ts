/**
 * Deploys AndroNodeEscrow using deploy/<network>.json.
 *   pnpm deploy:base-sepolia   (needs DEPLOYER_PRIVATE_KEY, ESCROW_ADMIN, OPERATOR_TREASURY)
 * Writes the result to deployments/<network>.json for the website and API.
 * Mainnet refuses to run unless AUDIT_COMMIT is set and the config has every address filled in.
 */
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";

interface DeployConfig {
  network: string;
  chainId: number;
  explorer: string;
  asset: { symbol: string; decimals: number; address: string | null };
  admin: string | null;
  operatorTreasury: string | null;
  maxOutstandingEscrowUnits: string;
  maxHardCloseWindowSeconds: number;
  requiresAudit?: boolean;
  deployTestToken?: boolean;
}

function need(label: string, v: string | null | undefined): `0x${string}` {
  if (!v || !isAddress(v)) throw new Error(`${label} is missing or not an address`);
  return getAddress(v);
}

async function main() {
  const net = hre.network.name;
  const publicClient = await hre.viem.getPublicClient();
  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY.");

  let cfg: DeployConfig;
  let asset: `0x${string}`;
  if (net === "hardhat" || net === "localhost") {
    const mock = await hre.viem.deployContract("MockUSDC");
    asset = mock.address;
    cfg = { network: net, chainId: 31337, explorer: "", asset: { symbol: "mUSDC", decimals: 6, address: asset }, admin: deployer.account.address, operatorTreasury: deployer.account.address, maxOutstandingEscrowUnits: "500000000", maxHardCloseWindowSeconds: 1209600 };
  } else {
    const files: Record<string, string> = { baseSepolia: "base-sepolia.json", base: "base-mainnet.json", robinhoodTestnet: "robinhood-testnet.json" };
    const file = files[net] ?? `${net}.json`;
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy", file), "utf8"));
    if (!cfg.asset.address && cfg.deployTestToken && !cfg.requiresAudit) {
      // Testnets without official USDC get a faucet token. TestUSDC itself refuses known mainnet chain ids.
      const token = await hre.viem.deployContract("TestUSDC");
      console.log(`Deployed TestUSDC at ${token.address}`);
      cfg.asset.address = token.address;
    }
    asset = need("asset.address", cfg.asset.address);
  }

  const chainId = await publicClient.getChainId();
  if (chainId !== cfg.chainId) throw new Error(`Connected to chain ${chainId}, config expects ${cfg.chainId}`);
  if (cfg.requiresAudit && !process.env.AUDIT_COMMIT) throw new Error("Mainnet deploy blocked: set AUDIT_COMMIT to the audited commit hash.");

  const admin = need("admin (ESCROW_ADMIN)", process.env.ESCROW_ADMIN ?? cfg.admin);
  const treasury = need("operatorTreasury (OPERATOR_TREASURY)", process.env.OPERATOR_TREASURY ?? cfg.operatorTreasury);

  // Sanity-check the asset really has the expected decimals.
  const decimals = await publicClient.readContract({
    address: asset,
    abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }],
    functionName: "decimals",
  });
  if (Number(decimals) !== cfg.asset.decimals) throw new Error(`Asset has ${decimals} decimals, config says ${cfg.asset.decimals}`);

  console.log(`Deploying AndroNodeEscrow to ${net} (${chainId}) from ${deployer.account.address}`);
  const escrow = await hre.viem.deployContract("AndroNodeEscrow", [
    asset, admin, treasury, BigInt(cfg.maxOutstandingEscrowUnits), cfg.maxHardCloseWindowSeconds,
  ]);
  const block = await publicClient.getBlockNumber();

  const out = {
    network: net,
    chainId,
    escrow: escrow.address,
    asset,
    assetSymbol: cfg.asset.symbol,
    assetDecimals: cfg.asset.decimals,
    admin,
    operatorTreasury: treasury,
    maxOutstandingEscrowUnits: cfg.maxOutstandingEscrowUnits,
    maxHardCloseWindowSeconds: cfg.maxHardCloseWindowSeconds,
    deployedAtBlock: block.toString(),
    deployedAt: new Date().toISOString(),
    explorer: cfg.explorer ? `${cfg.explorer}/address/${escrow.address}` : null,
    auditCommit: process.env.AUDIT_COMMIT ?? null,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));

  if (net !== "hardhat" && net !== "localhost" && process.env.BASESCAN_API_KEY) {
    await hre.run("verify:verify", {
      address: escrow.address,
      constructorArguments: [asset, admin, treasury, BigInt(cfg.maxOutstandingEscrowUnits), cfg.maxHardCloseWindowSeconds],
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
