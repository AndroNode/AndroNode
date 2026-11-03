import type { HardhatUserConfig } from "hardhat/config";
import { subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox-viem";
import path from "node:path";

const SOLC_VERSION = "0.8.28";

// Use the solc-js compiler bundled in node_modules instead of downloading a native binary.
// CI and local builds then compile with exactly the same pinned compiler, offline.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const compilerPath = path.join(path.dirname(require.resolve("solc/package.json")), "soljson.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const longVersion = require("solc/package.json").version as string;
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion };
  }
  return runSuper();
});

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = deployerKey ? [deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./src", tests: "./test" },
  networks: {
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org", chainId: 84532, accounts },
    base: { url: process.env.BASE_RPC_URL ?? "https://mainnet.base.org", chainId: 8453, accounts },
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY ?? "",
    customChains: [
      { network: "baseSepolia", chainId: 84532, urls: { apiURL: "https://api-sepolia.basescan.org/api", browserURL: "https://sepolia.basescan.org" } },
      { network: "base", chainId: 8453, urls: { apiURL: "https://api.basescan.org/api", browserURL: "https://basescan.org" } },
    ],
  },
  sourcify: { enabled: true },
};

export default config;
