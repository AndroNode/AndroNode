/**
 * Proposed protocol parameters from the AndroNode Whitepaper v1.0 (2 Nov 2026).
 * Every value here is a proposal or illustration, not a measured or live value.
 * Section numbers point to the whitepaper.
 */

/** §3.1 proposed device baseline. */
export const DEVICE_BASELINE = {
  minAndroidVersion: 11,
  requiredAbi: "arm64-v8a",
  minInstalledRamGb: 4,
  minAvailableRamGb: 1.5,
  minFreeStorageGb: 1,
} as const;

/** §5.1–5.2 proposed session defaults and resource controls. */
export const SESSION_DEFAULTS = {
  defaultMinutes: 30,
  maxMinutes: 120,
  minMinutes: 5,
  externalPowerRequired: true,
  batteryStartPercent: 80,
  batteryPausePercent: 70,
  unmeteredNetworkRequired: true,
  concurrentTasks: 1,
  maxCpuThreads: 2,
  dataBudgetBytesPerDay: 1024 ** 3,
  modelCacheBytes: 512 * 1024 ** 2,
  thermalRecoveryStableMs: 5 * 60 * 1000,
  nativeStopTargetMs: 5000,
} as const;

/** §4.1 reference embedding profile limits. */
export const EMBEDDING_PROFILE_LIMITS = {
  dimensions: 384,
  maxTokensPerRecord: 256,
  maxRecordsPerTask: 64,
  maxTaskPayloadBytes: 256 * 1024,
  taskDurationTargetSec: [5, 30] as const,
  modelPackageMaxBytes: 200 * 1024 ** 2,
  activeModelMemoryMaxBytes: 768 * 1024 ** 2,
} as const;

/** §8.2 lease and retry rules. */
export const LEASE_RULES = {
  maxLeaseSeconds: 120,
  uploadMarginSeconds: 30,
  heartbeatSeconds: 20,
  maxAutomaticAttempts: 3,
  activeLeasesPerDevice: 1,
} as const;

/** §9.1 candidate FP32 launch tolerances (uncalibrated). */
export const VERIFICATION_THRESHOLDS = {
  minCosine: 0.9999,
  maxAbsError: 0.001,
  minNorm: 0.999,
  maxNorm: 1.001,
} as const;

/** §9.2 and §13.3 review windows. */
export const REVIEW_WINDOWS = {
  contributorReviewMs: 7 * 24 * 3600 * 1000,
  customerDisputeMs: 48 * 3600 * 1000,
} as const;

/** Minimum hold before accepted rewards can be settled on a mainnet deployment (testnet may set less). */
export const MAINNET_MIN_REVIEW_SECONDS = 48 * 3600;

/** §13.2 escrow timing. */
export const ESCROW_TIMING = {
  maxExecutionWindowMs: 7 * 24 * 3600 * 1000,
  hardCloseMs: 14 * 24 * 3600 * 1000,
  settlementTargetDay: 11,
  maxRecipientsPerChunk: 100,
} as const;

/** §12.1 pricing rules. */
export const PRICING = {
  quoteValidityMs: 15 * 60 * 1000,
  contributorShareNumerator: 3n,
  shareDenominator: 4n,
  /** Illustrative only: $0.20 per 1,000 accepted records, six-decimal asset valued at $1. */
  illustrativeRatePer1kUnits: 200_000n,
} as const;

/** Asset assumption from §13.1. Real deployment must verify decimals. */
export const SETTLEMENT_ASSET = {
  symbol: "USDC",
  decimals: 6,
} as const;

/** §13.3 pilot caps, in whole asset units. */
export const PILOT_CAPS = {
  maxOutstandingEscrowUnits: 500n * 10n ** 6n,
  maxUnsettledExposureUnits: 50n * 10n ** 6n,
  operatorReserveUnits: 100n * 10n ** 6n,
} as const;

/** §10 probation caps. */
export const PROBATION = {
  deviceProvisionalCapUnits: 1n * 10n ** 6n,
  accountProvisionalCapUnits: 10n * 10n ** 6n,
  tasksToGraduate: 100,
  cleanDaysToGraduate: 7,
} as const;

/** §11 retention schedule. */
export const RETENTION = {
  payloadDays: 7,
  disputeEvidenceDays: 30,
  telemetryDays: 90,
  signedUrlTtlSeconds: 600,
} as const;
