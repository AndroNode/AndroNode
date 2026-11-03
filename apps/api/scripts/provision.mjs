// Ensures the Cloudflare resources in wrangler.jsonc exist, then writes wrangler.deploy.jsonc with their real IDs.
// Run from apps/api with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set. Safe to run on every deploy.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const wr = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tryWr = (...args) => {
  try {
    return wr(...args);
  } catch (e) {
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (/already exists|already taken|10026|11009/i.test(out)) return out;
    throw new Error(`wrangler ${args.join(" ")} failed:\n${out}`);
  }
};
const json = (text) => JSON.parse(text.slice(text.indexOf("[")));

const raw = readFileSync("wrangler.jsonc", "utf8");
const cfg = JSON.parse(raw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));

for (const d of cfg.d1_databases) {
  let found = json(wr("d1", "list", "--json")).find((x) => x.name === d.database_name);
  if (!found) {
    tryWr("d1", "create", d.database_name);
    found = json(wr("d1", "list", "--json")).find((x) => x.name === d.database_name);
  }
  d.database_id = found.uuid;
}
for (const k of cfg.kv_namespaces) {
  const title = `${cfg.name}-${k.binding.toLowerCase()}`;
  let found = json(wr("kv", "namespace", "list")).find((x) => x.title === title);
  if (!found) {
    tryWr("kv", "namespace", "create", title);
    found = json(wr("kv", "namespace", "list")).find((x) => x.title === title);
  }
  k.id = found.id;
}
for (const b of cfg.r2_buckets) tryWr("r2", "bucket", "create", b.bucket_name);
const queues = new Set([...cfg.queues.producers.map((q) => q.queue), ...cfg.queues.consumers.flatMap((q) => [q.queue, q.dead_letter_queue].filter(Boolean))]);
for (const q of queues) tryWr("queues", "create", q);

writeFileSync("wrangler.deploy.jsonc", JSON.stringify(cfg, null, 2));
console.log(JSON.stringify({ d1: cfg.d1_databases.map((d) => d.database_id), kv: cfg.kv_namespaces.map((k) => k.id), r2: cfg.r2_buckets.map((b) => b.bucket_name), queues: [...queues] }));
