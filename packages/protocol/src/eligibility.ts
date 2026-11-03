import { DEVICE_BASELINE, SESSION_DEFAULTS } from "./params.js";

export type FormFactor = "phone" | "tablet" | "tv";
export type ThermalStatus = "none" | "light" | "moderate" | "severe" | "critical";
export type NetworkKind = "unmetered" | "metered" | "offline";

export interface DeviceSpec {
  formFactor: FormFactor;
  androidVersion: number;
  abi: string;
  installedRamGb: number;
  availableRamGb: number;
  freeStorageGb: number;
  hasBattery: boolean;
}

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface EligibilityResult {
  mayMeetBaseline: boolean;
  /** Never "approved": passing specs only means testing is still required (§3.1). */
  summary: string;
  checks: CheckResult[];
  cohortNote?: string;
}

export function evaluateDevice(d: DeviceSpec): EligibilityResult {
  const b = DEVICE_BASELINE;
  const checks: CheckResult[] = [
    { id: "android", label: `Android ${b.minAndroidVersion} or later`, pass: d.androidVersion >= b.minAndroidVersion, detail: `Android ${d.androidVersion}` },
    { id: "abi", label: "64-bit ARM (arm64-v8a)", pass: d.abi === b.requiredAbi, detail: d.abi },
    { id: "ram", label: `At least ${b.minInstalledRamGb} GB installed RAM`, pass: d.installedRamGb >= b.minInstalledRamGb, detail: `${d.installedRamGb} GB` },
    { id: "avail", label: `At least ${b.minAvailableRamGb} GB available memory`, pass: d.availableRamGb >= b.minAvailableRamGb, detail: `${d.availableRamGb} GB` },
    { id: "storage", label: `At least ${b.minFreeStorageGb} GB free storage`, pass: d.freeStorageGb >= b.minFreeStorageGb, detail: `${d.freeStorageGb} GB` },
  ];
  const ok = checks.every((c) => c.pass);
  return {
    mayMeetBaseline: ok,
    summary: ok ? "May meet baseline — testing still required" : "Does not meet the proposed baseline",
    checks,
    cohortNote: d.formFactor === "tv" ? "Android TV boxes are a separate expansion cohort, not part of the paid launch (§3.1, §18.4)." : undefined,
  };
}

export interface SessionConditions {
  externalPower: boolean;
  batteryPercent: number | null;
  network: NetworkKind;
  thermal: ThermalStatus;
  dataUsedBytes: number;
  dataBudgetBytes: number;
  ownerStopped: boolean;
  /** true while a battery device is below start threshold but was not yet working */
  working: boolean;
}

export type SessionGate =
  | { kind: "run"; reducedLoad: boolean }
  | { kind: "pause"; reason: string }
  | { kind: "stop"; reason: string };

/** Applies §5.2 controls: may this device take (or keep) a lease right now? */
export function sessionGate(c: SessionConditions): SessionGate {
  if (c.ownerStopped) return { kind: "stop", reason: "Stopped by owner" };
  if (!c.externalPower) return { kind: "pause", reason: "External power lost" };
  if (c.network === "offline") return { kind: "pause", reason: "No network connection" };
  if (c.network === "metered") return { kind: "pause", reason: "Metered network: mobile data is off by default" };
  if (c.dataUsedBytes >= c.dataBudgetBytes) return { kind: "pause", reason: "Daily data budget used up" };
  if (c.thermal === "severe" || c.thermal === "critical") return { kind: "pause", reason: "Paused for temperature" };
  if (c.batteryPercent !== null) {
    if (!c.working && c.batteryPercent < SESSION_DEFAULTS.batteryStartPercent) {
      return { kind: "pause", reason: `Battery below ${SESSION_DEFAULTS.batteryStartPercent}% start threshold` };
    }
    if (c.working && c.batteryPercent < SESSION_DEFAULTS.batteryPausePercent) {
      return { kind: "pause", reason: `Battery below ${SESSION_DEFAULTS.batteryPausePercent}% pause threshold` };
    }
  }
  return { kind: "run", reducedLoad: c.thermal === "moderate" };
}
