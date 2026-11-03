/**
 * Separate order and task-attempt state machines (§8.1).
 * The website simulations and the real coordinator both use these transitions.
 */

export const ORDER_STATES = ["QUOTED", "FUNDED", "RUNNING", "COMPLETED", "PARTIAL", "CANCELLED", "FAILED", "CLOSED"] as const;
export type OrderState = (typeof ORDER_STATES)[number];

const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  QUOTED: ["FUNDED", "CANCELLED"],
  FUNDED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"],
  COMPLETED: ["CLOSED"],
  PARTIAL: ["CLOSED"],
  CANCELLED: ["CLOSED"],
  FAILED: ["CLOSED"],
  CLOSED: [],
};

export const TASK_STATES = ["QUEUED", "LEASED", "SUBMITTED", "VERIFYING", "ACCEPTED", "REJECTED", "EXPIRED", "FAILED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["LEASED", "CANCELLED"],
  LEASED: ["SUBMITTED", "EXPIRED", "CANCELLED"],
  SUBMITTED: ["VERIFYING", "REJECTED"],
  VERIFYING: ["ACCEPTED", "REJECTED"],
  ACCEPTED: [],
  // A rejected or expired attempt goes back to the queue if attempts remain, otherwise fails.
  REJECTED: ["QUEUED", "FAILED"],
  EXPIRED: ["QUEUED", "FAILED"],
  FAILED: [],
  CANCELLED: [],
};

export const PAYMENT_STATES = ["PROVISIONAL", "CLAIMABLE", "WITHDRAWN", "HELD"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  PROVISIONAL: ["CLAIMABLE", "HELD"],
  HELD: ["PROVISIONAL", "CLAIMABLE"],
  CLAIMABLE: ["WITHDRAWN"],
  WITHDRAWN: [],
};

export class TransitionError extends Error {}

function check<S extends string>(table: Record<S, readonly S[]>, kind: string, from: S, to: S): S {
  if (!table[from].includes(to)) throw new TransitionError(`${kind}: ${from} -> ${to} is not allowed`);
  return to;
}

export const canOrder = (from: OrderState, to: OrderState) => ORDER_TRANSITIONS[from].includes(to);
export const canTask = (from: TaskState, to: TaskState) => TASK_TRANSITIONS[from].includes(to);
export const transitionOrder = (from: OrderState, to: OrderState) => check(ORDER_TRANSITIONS, "order", from, to);
export const transitionTask = (from: TaskState, to: TaskState) => check(TASK_TRANSITIONS, "task", from, to);
export const transitionPayment = (from: PaymentState, to: PaymentState) => check(PAYMENT_TRANSITIONS, "payment", from, to);

export const TERMINAL_TASK_STATES: readonly TaskState[] = ["ACCEPTED", "FAILED", "CANCELLED"];

/** §9.2 rejection reason codes. */
export const REJECTION_REASONS = {
  INVALID_SIGNATURE: "The result envelope signature did not match the registered device key.",
  WRONG_PROFILE: "The output was produced under a different model profile than the lease required.",
  SCHEMA_ERROR: "Record IDs, count or vector dimensions did not match the task.",
  NONFINITE_OUTPUT: "A vector contained NaN or infinite values.",
  NUMERIC_MISMATCH: "A vector differed from the reference beyond the profile tolerances.",
  LEASE_EXPIRED: "The complete submission arrived after the lease deadline.",
} as const;
export type RejectionReason = keyof typeof REJECTION_REASONS;

/** §15.1 contributor status labels. */
export const CONTRIBUTOR_STATUS_LABELS = [
  "Not compatible",
  "Ready",
  "Waiting for work",
  "Working",
  "Paused by owner",
  "Paused for temperature",
  "Verifying",
  "Provisional reward",
  "Claimable",
  "Withdrawn",
] as const;
