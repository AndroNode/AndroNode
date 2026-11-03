import type { Env } from "../env";

/**
 * Fallback for when the account has no R2 (testnet without an R2 plan): stores blobs in KV under "blob:".
 * Covers only the R2 calls the API uses: get(key) -> { json, text } | null, and put(key, string).
 */
export function kvBlobs(kv: KVNamespace): R2Bucket {
  return {
    async get(key: string) {
      const text = await kv.get(`blob:${key}`);
      if (text === null) return null;
      return { json: async () => JSON.parse(text), text: async () => text };
    },
    async put(key: string, value: string) {
      await kv.put(`blob:${key}`, value);
      return null;
    },
  } as unknown as R2Bucket;
}

export function withBlobs(env: Env): Env {
  if (!env.BLOBS) env.BLOBS = kvBlobs(env.KV);
  return env;
}
