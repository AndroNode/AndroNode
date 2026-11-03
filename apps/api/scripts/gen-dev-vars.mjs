// Creates apps/api/.dev.vars with fresh local-only secrets for `wrangler dev`. Never commit the output.
import { writeFileSync, existsSync } from "node:fs";
if (existsSync(".dev.vars") && !process.argv.includes("--force")) {
  console.log(".dev.vars exists (use --force to replace)");
  process.exit(0);
}
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const admin = process.env.ADMIN_ADDRESSES ?? "";
writeFileSync(".dev.vars", [`SESSION_SECRET=${secret}`, `COORDINATOR_KEY_JWK=${JSON.stringify(jwk)}`, "SITE_ORIGIN=http://localhost:8787", `ADMIN_ADDRESSES=${admin}`, "REVIEW_WINDOW_SECONDS=60", ""].join("\n"), { mode: 0o600 });
console.log("wrote .dev.vars");
