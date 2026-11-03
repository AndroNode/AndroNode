import { z } from "zod";
import { EMBEDDING_PROFILE_LIMITS } from "./params.js";

export const PROTOCOL_VERSION = "andronode/1";

const unitsString = z.string().regex(/^\d+$/, "integer units as a string");
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address");

export const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  text: z.string().min(1).max(4096),
});

export const quoteRequestSchema = z.object({
  profileId: z.string().min(1),
  records: z.array(recordSchema).min(1).max(100_000),
  deadlineHours: z.number().int().min(1).max(168).default(24),
  acceptDataBoundary: z.literal(true, { errorMap: () => ({ message: "You must confirm the inputs are non-sensitive and you have rights to process them" }) }),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const orderCreateSchema = z.object({
  quoteId: z.string(),
  fundingTxHash: hex32.optional(),
});

/** §22.2 required task envelope. */
export const taskEnvelopeSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  order_id: z.string(),
  task_id: z.string(),
  lease_id: z.string(),
  device_key_id: z.string(),
  profile_id: z.string(),
  input_manifest_digest: z.string(),
  record_count: z.number().int().min(1).max(EMBEDDING_PROFILE_LIMITS.maxRecordsPerTask),
  max_tokens: z.number().int(),
  reward_asset: z.string(),
  reward_units: unitsString,
  issued_at: z.number().int(),
  expires_at: z.number().int(),
  nonce: z.string(),
  coordinator_signature: z.string(),
});
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;

/** Result envelope (§22.2): adds lease id, output digest, completed count, status and device signature. */
export const resultEnvelopeSchema = z.object({
  lease_id: z.string(),
  output_digest: z.string(),
  completed_record_count: z.number().int().min(0),
  execution_status: z.enum(["COMPLETED", "FAILED"]),
  profile_id: z.string(),
  outputs: z.array(z.object({ id: z.string(), vector: z.array(z.number()) })),
  diagnostics: z.record(z.unknown()).optional(),
  device_signature: z.string(),
});
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

export const deviceRegisterSchema = z.object({
  publicKeyJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() }),
  formFactor: z.enum(["phone", "tablet", "tv", "test-node"]),
  label: z.string().max(64).optional(),
  challenge: z.string(),
  signature: z.string(),
});

export const sessionStartSchema = z.object({
  deviceId: z.string(),
  minutes: z.number().int().min(5).max(120).default(30),
  limits: z
    .object({ maxThreads: z.number().int().min(1).max(2).default(2), dataBudgetBytes: z.number().int().positive().optional() })
    .default({}),
});
