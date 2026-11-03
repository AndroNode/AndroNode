import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { privateKeyToAccount } from "viem/accounts";

// Fixed, publicly known test keys. Never fund these addresses.
export const TEST_KEYS = {
  admin: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  customer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  contributor: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  other: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-session-secret-0123456789abcdef-xyz",
            COORDINATOR_KEY_JWK: JSON.stringify(jwk),
            SITE_ORIGIN: "https://andronode.test",
            ADMIN_ADDRESSES: privateKeyToAccount(TEST_KEYS.admin).address.toLowerCase(),
            REVIEW_WINDOW_SECONDS: "0",
            TEST_KEYS: JSON.stringify(TEST_KEYS),
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
