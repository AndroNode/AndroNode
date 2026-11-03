/** Deterministic JSON (sorted keys) so digests match across Workers, Node and the verifier. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof v === "bigint") return v.toString();
  return v;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function digestOf(value: unknown): Promise<string> {
  return "sha256:" + (await sha256Hex(canonicalJson(value)));
}

/** Random opaque ID with a readable prefix, e.g. ord_8f3k2... */
export function newId(prefix: string, bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  const alphabet = "0123456789abcdefghijkmnpqrstuvwxyz";
  let s = "";
  for (const x of b) s += alphabet[x % alphabet.length];
  return `${prefix}_${s}`;
}
