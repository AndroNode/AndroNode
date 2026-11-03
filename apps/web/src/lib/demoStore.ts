import { useEffect, useState } from "react";
import { getJson, setJson, removeItem } from "./storage";

/**
 * Shared simulation state that survives in-site navigation (PRD §6).
 * Lives in sessionStorage only. Contains nothing sensitive.
 */
export interface DemoState {
  profileId: string | null;
  order: null | {
    orderId: string;
    recordIds: string[];
    scenario: string;
    acceptedRecordIds: string[];
    receiptIds: string[];
    rejected: { taskId: string; reason: string }[];
    finished: boolean;
  };
  rewardStage: "provisional" | "claimable" | "withdrawn";
}

const KEY = "an-demo-v1";
const initial: DemoState = { profileId: null, order: null, rewardStage: "provisional" };
const listeners = new Set<(s: DemoState) => void>();

export function readDemo(): DemoState {
  if (typeof window === "undefined") return initial;
  return { ...initial, ...getJson<Partial<DemoState>>(KEY, {}) };
}

export function writeDemo(patch: Partial<DemoState>): DemoState {
  const next = { ...readDemo(), ...patch };
  setJson(KEY, next);
  listeners.forEach((l) => l(next));
  return next;
}

/** Reset clears counts, receipts and reward amounts together (PRD §6). */
export function resetDemo(): DemoState {
  removeItem(KEY, "session");
  listeners.forEach((l) => l(initial));
  return initial;
}

export function useDemo(): [DemoState, (p: Partial<DemoState>) => void] {
  const [state, setState] = useState<DemoState>(initial);
  useEffect(() => {
    setState(readDemo());
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return [state, (p) => writeDemo(p)];
}
