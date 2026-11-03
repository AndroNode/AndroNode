import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { d1Blobs } from "../src/lib/blobs";

const DB = (env as any).DB as D1Database;

describe("Workers Free fallbacks", () => {
  it("stores and reads blobs in D1, split into parts", async () => {
    const store = d1Blobs(DB);
    const big = JSON.stringify(Array.from({ length: 30_000 }, (_, i) => ({ id: `r${i}`, text: `record number ${i} with some padding text` })));
    expect(big.length).toBeGreaterThan(1_000_000);
    await store.put("orders/test/input.json", big);
    const parts = await DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE key = ?").bind("orders/test/input.json").first<{ n: number }>();
    expect(parts!.n).toBeGreaterThan(2);
    const got = await store.get("orders/test/input.json");
    expect(await got!.text()).toBe(big);
    expect((await got!.json()).length).toBe(30_000);
    // Overwrite with a smaller value leaves no stale parts.
    await store.put("orders/test/input.json", '{"small":true}');
    expect(await (await store.get("orders/test/input.json"))!.json()).toEqual({ small: true });
    expect(await store.get("missing")).toBeNull();
  });

  it("lets one request claim the periodic job per window", async () => {
    const at = Date.now() + 10_000_000;
    const a = await DB.prepare("UPDATE job_runs SET last_at = ? WHERE name = 'periodic' AND last_at < ?").bind(at, at - 120_000).run();
    const b = await DB.prepare("UPDATE job_runs SET last_at = ? WHERE name = 'periodic' AND last_at < ?").bind(at + 1, at + 1 - 120_000).run();
    expect(a.meta.changes).toBe(1);
    expect(b.meta.changes).toBe(0);
  });
});
