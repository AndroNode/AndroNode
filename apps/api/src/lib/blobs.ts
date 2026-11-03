import type { Env } from "../env";

/**
 * Blob storage when the account has no R2 plan (Workers Free). Blobs live in D1, split into parts so a
 * large order never hits D1's per-row size limit. KV is avoided on purpose: the free plan allows only
 * 1,000 KV writes a day, while D1 allows 100,000 rows written.
 * Covers the R2 calls the API uses: get(key) -> { json, text } | null, and put(key, string).
 */
const PART_CHARS = 500_000;

export function d1Blobs(db: D1Database): R2Bucket {
  return {
    async get(key: string) {
      const rows = await db.prepare("SELECT part, parts, body FROM blobs WHERE key = ? ORDER BY part").bind(key).all<{ part: number; parts: number; body: string }>();
      const r = rows.results;
      if (!r.length || r.length !== r[0]!.parts) return null;
      const text = r.map((x) => x.body).join("");
      return { json: async () => JSON.parse(text), text: async () => text };
    },
    async put(key: string, value: string) {
      const parts = Math.max(1, Math.ceil(value.length / PART_CHARS));
      const at = Date.now();
      const stmts = [db.prepare("DELETE FROM blobs WHERE key = ?").bind(key)];
      for (let i = 0; i < parts; i++) {
        stmts.push(db.prepare("INSERT INTO blobs (key, part, parts, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(key, i, parts, value.slice(i * PART_CHARS, (i + 1) * PART_CHARS), at));
      }
      await db.batch(stmts);
      return null;
    },
  } as unknown as R2Bucket;
}

/** Uses the R2 binding when it exists, otherwise the D1 store. */
export function withBlobs(env: Env): Env {
  if (!env.BLOBS) env.BLOBS = d1Blobs(env.DB);
  return env;
}
