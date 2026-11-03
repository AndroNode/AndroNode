# AndroNode

Website, testnet coordinator and USDC escrow for AndroNode, a proposed network where Android devices run small, verified AI embedding tasks for paying customers. Based on Whitepaper v1.0 and the website PRD.

> Status: the public website is a labelled simulation. The testnet app runs the real pipeline on Base Sepolia with test funds only. Nothing here is live on mainnet.

## What is in the repo

| Path | What it is |
| --- | --- |
| `apps/web` | Astro 5 site. Public pages and labs (simulations), docs, and the testnet app at `/app` (customer, contributor, admin). |
| `apps/api` | Cloudflare Worker: serves the site and the `/v1` API. D1 (authoritative state and double-entry ledger), R2 (records and results), Queues (verification, webhooks), KV (replay protection), rate limits, cron (lease expiry, chain sync). |
| `contracts` | `AndroNodeEscrow.sol`: non-upgradeable USDC escrow with strict 75/25 settlement, pull withdrawals and permissionless refund after hard close. Hardhat tests and deploy script. |
| `packages/protocol` | Shared rules: whitepaper parameters, money math, state machines, verification, schemas, escrow ABI. |
| `packages/fixtures` | Bundled demo data for the simulations. |
| `services/verifier` | Python ONNX reference verifier (all-MiniLM-L6-v2) for Cloudflare Containers. |
| `tools/test-node` | CLI that creates test orders and runs a simulated contributor device. |

## How a job flows

1. Customer signs in with their wallet (SIWE), gets a quote (records validated, long text rejected, never truncated), and funds `fundOrder` on the escrow (or simulated funding while no escrow is deployed).
2. The coordinator splits records into tasks of up to 64. A device with an active session gets one signed lease (at most 120 s, fenced by a generation counter).
3. The device downloads only its task's records, computes vectors and submits a signed result before the lease expires. Duplicate submissions return the original state; conflicting ones are refused.
4. The verification queue recomputes reference vectors and applies the profile tolerances (cosine ≥ 0.9999, max error ≤ 0.001, norm 0.999–1.001). Accepted tasks create one provisional reward and a balanced journal entry; rejected attempts are retried on another device.
5. After the review window, the admin prepares settlement chunks (≤ 100 recipients). Each is executed from the 2-of-3 Safe; the chain sync marks rewards claimable. Contributors withdraw themselves; customers reclaim unused escrow.

## Local development

```sh
pnpm install
pnpm --filter @andronode/web build                     # site the Worker serves
cd apps/api
ADMIN_ADDRESSES=0xYourAddress pnpm dev:vars            # local-only secrets in .dev.vars
npx wrangler d1 migrations apply andronode --local
npx wrangler dev                                        # http://localhost:8787 (site + API)
```

Run a test order and a simulated device against it (testnet-only keys):

```sh
API_URL=http://localhost:8787 WALLET_PRIVATE_KEY=0x... pnpm --filter @andronode/test-node start order --records 200
API_URL=http://localhost:8787 WALLET_PRIVATE_KEY=0x... pnpm --filter @andronode/test-node start node --minutes 5
```

## Tests

```sh
pnpm --filter @andronode/protocol test     # money, states, eligibility, verification
pnpm --filter ./contracts test             # escrow, including the PRD 10k/9k cases and a balance invariant
pnpm --filter @andronode/api test          # Workers-runtime tests: full lease → verify → settle flow, expiry, replay, cancel, rate limits
cd services/verifier && python -m pytest test_app.py
```

CI runs all of these on every push (`.github/workflows/ci.yml`).

## Deploying (GitHub Actions)

Repository **secrets**:

| Secret | Used by | Notes |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare deploys | Workers, D1, R2, KV, Queues edit permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare deploys | |
| `DEPLOYER_PRIVATE_KEY` | Contract deploy | Fresh testnet-only wallet with a little Base Sepolia ETH. Never reuse a mainnet key. |
| `BASE_SEPOLIA_RPC_URL` | Contract deploy, chain sync | Optional; defaults to the public endpoint for deploys. Needed by the Worker to read the chain. |
| `BASESCAN_API_KEY` | Contract verification | Optional. |
| `VERIFIER_TOKEN`, `VERIFIER_URL` | Verifier container | Only when `VERIFIER_MODE=container`. |

Repository **variables**: `ESCROW_ADMIN` (2-of-3 Safe), `OPERATOR_TREASURY`, `ESCROW_ADDRESS` (after the contract deploy), `ADMIN_ADDRESSES` (comma-separated wallets allowed in `/app/admin`), optional `SITE_ORIGIN`, `VERIFIER_MODE`, `ALLOW_MOCK_FUNDING`.

Order of operations:

1. Push to `main`. **Deploy to Cloudflare** creates D1/R2/KV/Queues if missing, applies migrations, deploys the Worker, generates `SESSION_SECRET` and `COORDINATOR_KEY_JWK` on first run, and smoke-tests `/v1/health`.
2. Run **Deploy escrow contract** (manual). It tests, deploys to Base Sepolia and opens a PR with `contracts/deployments/baseSepolia.json`.
3. Set `ESCROW_ADDRESS` and `BASE_SEPOLIA_RPC_URL`, then re-run **Deploy to Cloudflare**. Set `ALLOW_MOCK_FUNDING=false` once real test USDC funding is working.
4. Optional: run **Deploy verifier container**, then set `VERIFIER_MODE=container` and `VERIFIER_URL`.

## Mainnet readiness (not done, by design)

- Independent audit of `AndroNodeEscrow.sol`; `deploy/base-mainnet.json` refuses to deploy without `AUDIT_COMMIT`.
- Calibrated tolerances and a pinned model revision and SHA-256 in the verifier image.
- Published signer addresses, chain parameters and terms; `ALLOW_MOCK_FUNDING` and the fixture verifier are refused on mainnet.
- Pilot caps (500 USDC escrow, 50 USDC unsettled exposure) stay until reviewed.

## Notes on the implementation plan

- Lease assignment uses D1 conditional updates with a fencing generation instead of a Durable Object. Each lease is a single atomic statement, which keeps one source of truth and is covered by tests. A Durable Object scheduler can be added if contention appears.
- Settlement preparation, chain sync and lease expiry run in the API Worker's cron instead of a separate settler Worker.
- The testnet starts with a deterministic "pipeline test profile" so leasing, verification and payment can be exercised before the ONNX verifier is deployed. It has no semantic meaning and is labelled everywhere.
