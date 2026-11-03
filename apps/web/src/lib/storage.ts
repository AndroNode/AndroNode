/**
 * Browser storage that never blocks the page (PRD FR-03, NFR-07).
 * Every read/write is wrapped; denial or corrupt values fall back to memory.
 */
const memory = new Map<string, string>();

function store(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    const k = "__an_probe__";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export function getItem(key: string, kind: "local" | "session" = "local"): string | null {
  const s = store(kind);
  try {
    return s ? s.getItem(key) : (memory.get(`${kind}:${key}`) ?? null);
  } catch {
    return memory.get(`${kind}:${key}`) ?? null;
  }
}

export function setItem(key: string, value: string, kind: "local" | "session" = "local"): void {
  memory.set(`${kind}:${key}`, value);
  const s = store(kind);
  try {
    s?.setItem(key, value);
  } catch {
    /* in-memory only */
  }
}

export function removeItem(key: string, kind: "local" | "session" = "local"): void {
  memory.delete(`${kind}:${key}`);
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getJson<T>(key: string, fallback: T, kind: "local" | "session" = "session"): T {
  const raw = getItem(key, kind);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    removeItem(key, kind);
    return fallback;
  }
}

export function setJson(key: string, value: unknown, kind: "local" | "session" = "session"): void {
  setItem(key, JSON.stringify(value), kind);
}
