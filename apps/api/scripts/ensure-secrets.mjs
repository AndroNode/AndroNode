// Creates SESSION_SECRET and COORDINATOR_KEY_JWK on the deployed Worker the first time only.
// The values are generated here and sent straight to Cloudflare; they are never printed or stored in the repo.
import { execFileSync } from "node:child_process";

const config = process.argv[2] ?? "wrangler.deploy.jsonc";
const list = JSON.parse(execFileSync("npx", ["wrangler", "secret", "list", "--config", config, "--format", "json"], { encoding: "utf8" }).replace(/^[^[]*/, ""));
const have = new Set(list.map((s) => s.name));
const put = (name, value) => execFileSync("npx", ["wrangler", "secret", "put", name, "--config", config], { input: value, stdio: ["pipe", "inherit", "inherit"] });

if (!have.has("SESSION_SECRET")) put("SESSION_SECRET", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"));
if (!have.has("COORDINATOR_KEY_JWK")) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  put("COORDINATOR_KEY_JWK", JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)));
}
for (const [name, env] of [["BASE_RPC_URL", "BASE_RPC_URL"], ["VERIFIER_TOKEN", "VERIFIER_TOKEN"], ["VERIFIER_URL", "VERIFIER_URL"]]) {
  if (process.env[env]) put(name, process.env[env]);
}
console.log("secrets ok:", [...have].join(", ") || "(created)");
