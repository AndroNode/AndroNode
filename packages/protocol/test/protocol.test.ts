import { describe, expect, it } from "vitest";
import {
  allocate, settleOrder, formatUnits, parseUnits, perRecordCharge, PRICING,
  transitionTask, TransitionError, evaluateDevice, sessionGate, verifySubmission,
  planTasks, validateRecords, leaseWindow, canonicalJson, caState, CA_UNSET_TOOLTIP,
} from "../src/index.js";

const RATE = PRICING.illustrativeRatePer1kUnits;

describe("money (PRD AC-13.a, whitepaper §22.1)", () => {
  it("reference order reconciles", () => {
    const s = settleOrder(10_000, 10_000, RATE);
    expect(formatUnits(s.charge)).toBe("2.000000");
    expect(formatUnits(s.contributor)).toBe("1.500000");
    expect(formatUnits(s.service)).toBe("0.500000");
    expect(s.refund).toBe(0n);
  });
  it("partial order refunds the rest", () => {
    const s = settleOrder(10_000, 9_000, RATE);
    expect(formatUnits(s.charge)).toBe("1.800000");
    expect(formatUnits(s.contributor)).toBe("1.350000");
    expect(formatUnits(s.service)).toBe("0.450000");
    expect(formatUnits(s.refund)).toBe("0.200000");
  });
  it("zero accepted work earns zero", () => {
    const s = settleOrder(500, 0, RATE);
    expect(s.charge).toBe(0n);
    expect(s.contributor).toBe(0n);
  });
  it("task-level numbers match §22.1", () => {
    const per = perRecordCharge(RATE);
    expect(formatUnits(per * 64n)).toBe("0.012800");
    expect(formatUnits(allocate(per * 64n).contributor)).toBe("0.009600");
    expect(formatUnits(per * 16n)).toBe("0.003200");
    expect(formatUnits(allocate(per * 16n).contributor)).toBe("0.002400");
  });
  it("rejects prices that leave rounding dust", () => {
    expect(() => perRecordCharge(201_000n)).toThrow();
    expect(() => allocate(6n)).toThrow();
  });
  it("parses and formats", () => {
    expect(parseUnits("1.5")).toBe(1_500_000n);
    expect(() => parseUnits("0.0000001")).toThrow();
  });
});

describe("task planning", () => {
  it("10,000 records -> 156 x 64 + 1 x 16", () => {
    const recs = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}`, text: "short text", tokens: 4 }));
    const tasks = planTasks(recs, perRecordCharge(RATE));
    expect(tasks.length).toBe(157);
    expect(tasks.at(-1)!.recordIds.length).toBe(16);
    expect(tasks.slice(0, 156).every((t) => t.recordIds.length === 64)).toBe(true);
  });
  it("rejects too-long and duplicate records", () => {
    const issues = validateRecords([
      { id: "a", text: "x", tokens: 300 },
      { id: "a", text: "y", tokens: 3 },
    ]);
    expect(issues.map((i) => i.problem).sort()).toEqual(["DUPLICATE_ID", "TOO_LONG"]);
  });
  it("lease only when execution + margin fits", () => {
    expect(leaseWindow(0, 200_000, 20).ok).toBe(true);
    expect(leaseWindow(0, 40_000, 20).ok).toBe(false);
    expect(leaseWindow(0, 10 ** 9, 20).expiresAt).toBe(120_000);
  });
});

describe("states", () => {
  it("allows the happy path and blocks shortcuts", () => {
    expect(transitionTask("QUEUED", "LEASED")).toBe("LEASED");
    expect(() => transitionTask("QUEUED", "ACCEPTED")).toThrow(TransitionError);
    expect(() => transitionTask("ACCEPTED", "QUEUED")).toThrow(TransitionError);
  });
});

describe("device eligibility and session gate", () => {
  const phone = { formFactor: "phone" as const, androidVersion: 13, abi: "arm64-v8a", installedRamGb: 6, availableRamGb: 2, freeStorageGb: 8, hasBattery: true };
  it("never says approved", () => {
    const r = evaluateDevice(phone);
    expect(r.mayMeetBaseline).toBe(true);
    expect(r.summary).toContain("testing still required");
  });
  it("flags old Android", () => {
    expect(evaluateDevice({ ...phone, androidVersion: 10 }).mayMeetBaseline).toBe(false);
  });
  const base = { externalPower: true, batteryPercent: 90, network: "unmetered" as const, thermal: "none" as const, dataUsedBytes: 0, dataBudgetBytes: 1e9, ownerStopped: false, working: false };
  it("pauses on severe heat, power loss, budget; reduces on moderate", () => {
    expect(sessionGate({ ...base, thermal: "severe" }).kind).toBe("pause");
    expect(sessionGate({ ...base, externalPower: false }).kind).toBe("pause");
    expect(sessionGate({ ...base, dataUsedBytes: 2e9 }).kind).toBe("pause");
    expect(sessionGate({ ...base, ownerStopped: true }).kind).toBe("stop");
    expect(sessionGate({ ...base, thermal: "moderate" })).toEqual({ kind: "run", reducedLoad: true });
  });
  it("battery thresholds 80 start / 70 pause; batteryless ignores battery", () => {
    expect(sessionGate({ ...base, batteryPercent: 75 }).kind).toBe("pause");
    expect(sessionGate({ ...base, batteryPercent: 75, working: true }).kind).toBe("run");
    expect(sessionGate({ ...base, batteryPercent: 65, working: true }).kind).toBe("pause");
    expect(sessionGate({ ...base, batteryPercent: null }).kind).toBe("run");
  });
});

describe("verification §9", () => {
  const unit = (seed: number) => {
    const v = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.37 + seed));
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / n);
  };
  const ref = [unit(1), unit(2)];
  const ok = {
    expectedRecordIds: ["a", "b"], expectedProfileId: "p1", submittedProfileId: "p1", submittedRecordIds: ["a", "b"],
    submittedVectors: ref.map((v) => v.map((x) => x + 1e-6)), referenceVectors: ref, submittedAt: 10, leaseExpiresAt: 20, signatureValid: true,
  };
  it("accepts honest output", () => expect(verifySubmission(ok).decision).toBe("ACCEPTED"));
  it("rejects NaN", () => {
    const v = ref.map((x) => [...x]);
    v[0]![3] = NaN;
    expect(verifySubmission({ ...ok, submittedVectors: v }).reason).toBe("NONFINITE_OUTPUT");
  });
  it("rejects wrong dims, profile, lateness, mismatch", () => {
    expect(verifySubmission({ ...ok, submittedVectors: ref.map((v) => v.slice(0, 383)) }).reason).toBe("SCHEMA_ERROR");
    expect(verifySubmission({ ...ok, submittedProfileId: "p2" }).reason).toBe("WRONG_PROFILE");
    expect(verifySubmission({ ...ok, submittedAt: 30 }).reason).toBe("LEASE_EXPIRED");
    expect(verifySubmission({ ...ok, submittedVectors: [unit(5), unit(6)] }).reason).toBe("NUMERIC_MISMATCH");
    expect(verifySubmission({ ...ok, submittedVectors: [ref[0]!.map(() => 0), ref[1]!] }).reason).toBe("NUMERIC_MISMATCH");
  });
});

describe("config and CA chip (FR-16/17)", () => {
  const cfg = {
    displayName: "AndroNode", tagline: "", ticker: null, nativeTokenCa: null, nativeTokenCaOwnerConfirmed: false,
    chain: { id: 84532, name: "Base Sepolia", rpcUrl: "https://sepolia.base.org", explorerUrl: "https://sepolia.basescan.org", verified: true },
    settlement: { assetSymbol: "USDC", assetAddress: null, assetDecimals: 6, escrowAddress: null, adminSafe: null },
    social: { x: null, support: null },
    release: { status: "simulation" as const, evidenceDate: null },
  };
  it("unset CA uses the exact tooltip", () => {
    const s = caState(cfg);
    expect(s.kind).toBe("unset");
    expect(s.tooltip).toBe(CA_UNSET_TOOLTIP);
  });
  it("invalid CA is a config error", () => {
    expect(caState({ ...cfg, nativeTokenCa: "0x1234", nativeTokenCaOwnerConfirmed: true }).kind).toBe("invalid");
  });
  it("canonical json sorts keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 2n, c: 3 } })).toBe('{"a":{"c":3,"d":"2"},"b":1}');
  });
});
