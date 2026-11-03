/**
 * Bundled demo fixtures for the website simulations (PRD FR-09 to FR-13).
 * Everything here is synthetic and authored by hand or by a seeded generator.
 * Nothing here is model output, measured data or a real device.
 */
import { EMBEDDING_PROFILE_LIMITS } from "@andronode/protocol/params";
import type { DeviceSpec } from "@andronode/protocol/eligibility";

export const FIXTURE_PROVENANCE =
  "Synthetic demo fixture. Records are invented English sentences; token counts are authored; vectors come from a seeded generator, not from a model.";

// ------------------------------------------------------------------ devices

export interface DevicePreset extends DeviceSpec {
  id: string;
  name: string;
  note: string;
  defaultBatteryPercent: number | null;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "phone-mid", name: "Mid-range phone (hypothetical)", formFactor: "phone", androidVersion: 14, abi: "arm64-v8a", installedRamGb: 6, availableRamGb: 2.4, freeStorageGb: 22, hasBattery: true, defaultBatteryPercent: 92, note: "Typical recent phone." },
  { id: "tablet-10", name: "10-inch tablet (hypothetical)", formFactor: "tablet", androidVersion: 13, abi: "arm64-v8a", installedRamGb: 8, availableRamGb: 3.1, freeStorageGb: 40, hasBattery: true, defaultBatteryPercent: 88, note: "Larger battery and more memory." },
  { id: "phone-old", name: "Older phone, Android 10 (hypothetical)", formFactor: "phone", androidVersion: 10, abi: "arm64-v8a", installedRamGb: 4, availableRamGb: 1.6, freeStorageGb: 9, hasBattery: true, defaultBatteryPercent: 81, note: "Below the Android 11 baseline." },
  { id: "phone-3gb", name: "Entry phone, 3 GB RAM (hypothetical)", formFactor: "phone", androidVersion: 12, abi: "arm64-v8a", installedRamGb: 3, availableRamGb: 1.1, freeStorageGb: 6, hasBattery: true, defaultBatteryPercent: 95, note: "Below the 4 GB installed RAM baseline." },
  { id: "phone-32bit", name: "32-bit only device (hypothetical)", formFactor: "phone", androidVersion: 11, abi: "armeabi-v7a", installedRamGb: 4, availableRamGb: 1.8, freeStorageGb: 12, hasBattery: true, defaultBatteryPercent: 90, note: "No 64-bit ARM environment." },
  { id: "tv-box", name: "Android TV box (hypothetical)", formFactor: "tv", androidVersion: 12, abi: "arm64-v8a", installedRamGb: 4, availableRamGb: 1.7, freeStorageGb: 10, hasBattery: false, defaultBatteryPercent: null, note: "Expansion-cohort example only. No battery." },
];

// ------------------------------------------------------------------ profile

export const DEMO_PROFILE = {
  id: "demo-profile/minilm-l6-v2/cpu-fp32/r0",
  fictionalIdNote: "Fictional demo identifier. Not a production profile hash.",
  taskType: "embedding" as const,
  title: "Short English text embedding",
  candidateModel: "sentence-transformers/all-MiniLM-L6-v2",
  modelSource: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2",
  license: "Apache 2.0 (as listed by the publisher; license and conversion review pending)",
  runtime: "ONNX Runtime Android, CPU, FP32 (proposed)",
  dimensions: EMBEDDING_PROFILE_LIMITS.dimensions,
  normalized: true,
  maxTokensPerRecord: EMBEDDING_PROFILE_LIMITS.maxTokensPerRecord,
  maxRecordsPerTask: EMBEDDING_PROFILE_LIMITS.maxRecordsPerTask,
  maxTaskPayloadBytes: EMBEDDING_PROFILE_LIMITS.maxTaskPayloadBytes,
  status: "candidate" as const,
};

export const DEFERRED_PROFILES = [
  { id: "deferred/classification", taskType: "classification", title: "Text classification", reason: "Needs approved labels and a fixed scoring method (§4.2)." },
  { id: "deferred/ocr", taskType: "ocr", title: "OCR", reason: "Needs document-level quality criteria and separate privacy testing (§1, §4.2)." },
  { id: "deferred/audio", taskType: "audio", title: "Short audio transcription", reason: "Needs language, audio and error-rate criteria (§4.2)." },
] as const;

// ------------------------------------------------------------------ records

export interface FixtureRecord {
  id: string;
  text: string;
  tokens: number;
}

const SENTENCES = [
  "Solar panels convert sunlight into electricity using semiconductor cells.",
  "The library opens at nine and closes at six on weekdays.",
  "A gentle rain fell over the valley throughout the afternoon.",
  "Fresh basil adds a bright flavor to tomato sauce.",
  "Trains on the coastal line run every twenty minutes.",
  "The museum exhibit explains how early maps were drawn.",
  "Regular stretching can help reduce stiffness after long walks.",
  "Bread rises when yeast produces carbon dioxide in the dough.",
  "The city council approved a plan for new bicycle lanes.",
  "Honeybees communicate the location of flowers through movement.",
  "A compass needle points toward the magnetic north pole.",
  "The bakery sells sourdough loaves every Saturday morning.",
  "Wind turbines are often placed on hills and along coastlines.",
  "Reading aloud to children helps build early vocabulary.",
  "The river freezes along its edges during the coldest weeks.",
  "Recycled glass can be melted and formed into new bottles.",
  "The park has a walking trail that circles the lake.",
  "Owls hunt mostly at night and rely on sharp hearing.",
  "A good night of sleep supports memory and concentration.",
  "The festival features local music, crafts and food stalls.",
  "Tea leaves are dried and rolled before they are packed.",
  "The bridge was repainted to protect the steel from rust.",
  "Seeds need water, warmth and light to start growing.",
  "The weather station records temperature every ten minutes.",
];

export const SAMPLE_RECORDS: FixtureRecord[] = SENTENCES.map((text, i) => ({
  id: `rec-${String(i + 1).padStart(3, "0")}`,
  text,
  // Authored approximate counts including the two special tokens.
  tokens: Math.round(text.split(/\s+/).length * 1.3) + 2,
}));

/** An over-limit record to demonstrate rejection instead of silent truncation. */
export const OVER_LIMIT_RECORD: FixtureRecord = {
  id: "rec-long",
  text: "This deliberately long synthetic paragraph stands in for a document that exceeds the per-record token limit. ".repeat(14).trim(),
  tokens: 312,
};

// ------------------------------------------------------------------ vectors

/** Seeded PRNG (mulberry32) so every visitor sees the same authored vectors. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Authored 384-dimensional unit vector for a record ID. Not a model embedding. */
export function authoredVector(id: string, dims: number = EMBEDDING_PROFILE_LIMITS.dimensions): number[] {
  const r = rng(seedOf(id));
  const v = Array.from({ length: dims }, () => r() * 2 - 1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}

/** A device-side copy with tiny numeric noise, like a different CPU would produce. */
export function deviceVector(id: string, noise = 2e-6): number[] {
  const r = rng(seedOf(id) ^ 0x9e3779b9);
  return authoredVector(id).map((x) => x + (r() * 2 - 1) * noise);
}

// ------------------------------------------------------------------ receipts

export type ReceiptCaseId = "valid" | "wrong-profile" | "nonfinite" | "dimension-mismatch" | "expired";

export interface ReceiptCase {
  id: ReceiptCaseId;
  receiptId: string;
  title: string;
  orderId: string;
  taskId: string;
  leaseId: string;
  recordIds: string[];
  submittedProfileId: string;
  submittedAtOffsetSec: number;
  leaseSeconds: number;
  mutate: "none" | "nan" | "truncate" | "none-wrong-profile";
}

const caseRecords = SAMPLE_RECORDS.slice(0, 4).map((r) => r.id);

export const RECEIPT_CASES: ReceiptCase[] = [
  { id: "valid", receiptId: "demo-rcpt-0001", title: "Accepted task", orderId: "demo-ord-0001", taskId: "demo-task-0001", leaseId: "demo-lease-0001", recordIds: caseRecords, submittedProfileId: DEMO_PROFILE.id, submittedAtOffsetSec: 21, leaseSeconds: 120, mutate: "none" },
  { id: "wrong-profile", receiptId: "demo-rcpt-0002", title: "Wrong model profile", orderId: "demo-ord-0001", taskId: "demo-task-0002", leaseId: "demo-lease-0002", recordIds: caseRecords, submittedProfileId: "demo-profile/minilm-l6-v2/cpu-int8/r0", submittedAtOffsetSec: 18, leaseSeconds: 120, mutate: "none-wrong-profile" },
  { id: "nonfinite", receiptId: "demo-rcpt-0003", title: "NaN in a vector", orderId: "demo-ord-0001", taskId: "demo-task-0003", leaseId: "demo-lease-0003", recordIds: caseRecords, submittedProfileId: DEMO_PROFILE.id, submittedAtOffsetSec: 25, leaseSeconds: 120, mutate: "nan" },
  { id: "dimension-mismatch", receiptId: "demo-rcpt-0004", title: "Wrong vector length", orderId: "demo-ord-0001", taskId: "demo-task-0004", leaseId: "demo-lease-0004", recordIds: caseRecords, submittedProfileId: DEMO_PROFILE.id, submittedAtOffsetSec: 19, leaseSeconds: 120, mutate: "truncate" },
  { id: "expired", receiptId: "demo-rcpt-0005", title: "Submitted after lease expiry", orderId: "demo-ord-0001", taskId: "demo-task-0005", leaseId: "demo-lease-0005", recordIds: caseRecords, submittedProfileId: DEMO_PROFILE.id, submittedAtOffsetSec: 131, leaseSeconds: 120, mutate: "none" },
];

export function submittedVectorsFor(c: ReceiptCase): number[][] {
  return c.recordIds.map((id, i) => {
    const v = deviceVector(id);
    if (c.mutate === "nan" && i === 1) v[17] = Number.NaN;
    if (c.mutate === "truncate") return v.slice(0, 256);
    return v;
  });
}

// ------------------------------------------------------------------ workload scenarios

export type WorkloadScenario = "complete" | "partial" | "rejected" | "cancelled" | "verifier-delayed";

export const WORKLOAD_SCENARIOS: { id: WorkloadScenario; title: string; description: string }[] = [
  { id: "complete", title: "Complete", description: "Every task is leased, submitted on time and accepted." },
  { id: "partial", title: "Partial at deadline", description: "Some tasks are not finished when the deadline ends. Accepted records are kept; unfinished ones are refunded." },
  { id: "rejected", title: "Rejected attempt, then retry", description: "One attempt fails verification. The task is retried on another device without double charging." },
  { id: "cancelled", title: "Customer cancels", description: "New leases stop. Work already leased stays payable if submitted on time and accepted." },
  { id: "verifier-delayed", title: "Verifier delayed", description: "Timely submissions wait in Verifying. A backlog never turns them into expired leases." },
];
