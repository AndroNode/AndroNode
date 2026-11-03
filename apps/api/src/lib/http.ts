import type { Context } from "hono";
import type { ZodSchema } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

export const bad = (code: string, message: string, detail?: unknown) => new ApiError(400, code, message, detail);
export const unauthorized = (message = "Sign in required") => new ApiError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Not allowed") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export async function body<T>(c: Context, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw bad("INVALID_JSON", "Request body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw bad("VALIDATION", "Request body is invalid", r.error.flatten());
  return r.data;
}

export const now = () => Date.now();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
