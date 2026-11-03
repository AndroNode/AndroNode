#!/usr/bin/env bash
# Deploys the site and API straight to Cloudflare without GitHub Actions. Mirrors .github/workflows/deploy-cloudflare.yml.
# Needs in the environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
# Optional: ESCROW_ADDRESS and USDC_ADDRESS (from /app/deploy), ADMIN_ADDRESSES, SITE_ORIGIN.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

pnpm install --frozen-lockfile
PUBLIC_ESCROW_ADDRESS="${ESCROW_ADDRESS:-}" pnpm --filter @andronode/web build
pnpm --filter @andronode/api test

cd apps/api
node scripts/provision.mjs
npx wrangler d1 migrations apply andronode --remote --config wrangler.deploy.jsonc
VARS=()
[ -n "${ESCROW_ADDRESS:-}" ] && VARS+=(--var "ESCROW_ADDRESS:$ESCROW_ADDRESS")
[ -n "${USDC_ADDRESS:-}" ] && VARS+=(--var "USDC_ADDRESS:$USDC_ADDRESS")
[ -n "${ADMIN_ADDRESSES:-}" ] && VARS+=(--var "ADMIN_ADDRESSES:$ADMIN_ADDRESSES")
npx wrangler deploy --config wrangler.deploy.jsonc "${VARS[@]}" | tee /tmp/andronode-deploy.log
node scripts/ensure-secrets.mjs wrangler.deploy.jsonc

URL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.deploy.jsonc","utf8")).vars.SITE_ORIGIN)')
sleep 5
curl -fsS "$URL/v1/health" && echo
curl -fsS -o /dev/null -w "site %{http_code}\n" "$URL/"
echo "Deployed: $URL"
