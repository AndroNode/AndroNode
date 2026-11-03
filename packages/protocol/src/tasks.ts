import { EMBEDDING_PROFILE_LIMITS, LEASE_RULES } from "./params.js";
import { allocate, type Units } from "./money.js";

export interface RecordInput {
  id: string;
  text: string;
  tokens: number;
}

export interface TaskPlan {
  index: number;
  recordIds: string[];
  charge: Units;
  reward: Units;
}

/** Groups records into tasks of at most 64 records and 256 KiB (§4.1, §22.1). */
export function planTasks(records: RecordInput[], perRecordCharge: Units, maxRecords: number = EMBEDDING_PROFILE_LIMITS.maxRecordsPerTask): TaskPlan[] {
  const enc = new TextEncoder();
  const tasks: TaskPlan[] = [];
  let current: RecordInput[] = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    const charge = perRecordCharge * BigInt(current.length);
    tasks.push({ index: tasks.length, recordIds: current.map((r) => r.id), charge, reward: allocate(charge).contributor });
    current = [];
    bytes = 0;
  };
  for (const r of records) {
    const size = enc.encode(r.id).length + enc.encode(r.text).length + 16;
    if (current.length >= maxRecords || bytes + size > EMBEDDING_PROFILE_LIMITS.maxTaskPayloadBytes) flush();
    current.push(r);
    bytes += size;
  }
  flush();
  return tasks;
}

export interface RecordIssue {
  id: string;
  problem: "EMPTY" | "TOO_LONG" | "DUPLICATE_ID" | "BAD_ID";
  detail: string;
}

/** Validates records before a quote. Long text is rejected, never silently truncated (§4.1). */
export function validateRecords(records: RecordInput[], maxTokens: number = EMBEDDING_PROFILE_LIMITS.maxTokensPerRecord): RecordIssue[] {
  const issues: RecordIssue[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(r.id)) issues.push({ id: r.id, problem: "BAD_ID", detail: "IDs use letters, digits, . _ : - (max 128)" });
    if (seen.has(r.id)) issues.push({ id: r.id, problem: "DUPLICATE_ID", detail: "Record IDs must be unique" });
    seen.add(r.id);
    if (!r.text.trim()) issues.push({ id: r.id, problem: "EMPTY", detail: "Text is empty" });
    if (r.tokens > maxTokens) issues.push({ id: r.id, problem: "TOO_LONG", detail: `${r.tokens} tokens exceeds the ${maxTokens}-token limit` });
  }
  return issues;
}

/** §8.2: a lease is issued only if estimated execution + upload margin fits before the order deadline. */
export function leaseWindow(nowMs: number, orderDeadlineMs: number, estimatedExecSec: number): { ok: boolean; expiresAt: number } {
  const expiresAt = Math.min(nowMs + LEASE_RULES.maxLeaseSeconds * 1000, orderDeadlineMs);
  const needed = (estimatedExecSec + LEASE_RULES.uploadMarginSeconds) * 1000;
  return { ok: nowMs + needed <= expiresAt, expiresAt };
}
