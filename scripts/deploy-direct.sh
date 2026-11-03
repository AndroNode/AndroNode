#!/usr/bin/env bash
# Deploys the site and API straight to Cloudflare without GitHub Actions. Mirrors .github/workflows/deploy-cloudflare.yml.
# Needs in the environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
# Optional: ESCROW_ADDRESS, ADMIN_ADDRESSES, SITE_ORIGIN, BASE_RPC_URL (defaults to the public Base Sepolia RPC).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
export BASE_RPC_URL="${BASE_RPC_URL:-https://sepolia.base.org}"

pnpm install --frozen-lockfile
PUBLIC_ESCROW_ADDRESS="${ESCROW_ADDRESS:-}" pnpm --filter @andronode/web build
pnpm --filter @andronode/api test

cd apps/api
node scripts/provision.mjs
npx wrangler d1 migrations apply andronode --remote --config wrangler.deploy.jsonc
VARS=()
[ -n "${ESCROW_ADDRESS:-}" ] && VARS+=(--var "ESCROW_ADDRESS:$ESCROW_ADDRESS")
[ -n "${ADMIN_ADDRESSES:-}" ] && VARS+=(--var "ADMIN_ADDRESSES:$ADMIN_ADDRESSES")
npx wrangler deploy --config wrangler.deploy.jsonc "${VARS[@]}" | tee /tmp/andronode-deploy.log
node scripts/ensure-secrets.mjs wrangler.deploy.jsonc

URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.deploy.jsonc","utf8")).vars.SITE_ORIGIN)')
sleep 5
curl -fsS "$URL/v1/health" && echo
curl -fsS -o /dev/null -w "site %{http_code}\n" "$URL/"
echo "Deployed: $URL"
