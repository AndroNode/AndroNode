import { PRICING, SETTLEMENT_ASSET } from "./params.js";

/** All money is integer smallest units of the settlement asset (bigint). */
export type Units = bigint;

export class MoneyError extends Error {}

const UNIT = 10n ** BigInt(SETTLEMENT_ASSET.decimals);

/** Per-record charge from a per-1,000 rate. Must be an integer divisible by 4 (§12.1). */
export function perRecordCharge(ratePer1kUnits: Units): Units {
  if (ratePer1kUnits <= 0n) throw new MoneyError("Rate must be positive");
  if (ratePer1kUnits % 1000n !== 0n) {
    throw new MoneyError("Rate per 1,000 records must give a whole per-record charge");
  }
  const perRecord = ratePer1kUnits / 1000n;
  if (perRecord % PRICING.shareDenominator !== 0n) {
    throw new MoneyError("Per-record charge must be divisible by 4 so the 75/25 split has no rounding dust");
  }
  return perRecord;
}

export interface Allocation {
  charge: Units;
  contributor: Units;
  service: Units;
}

/** Splits an accepted charge 75/25. Throws if the charge is not divisible by 4. */
export function allocate(charge: Units): Allocation {
  if (charge < 0n) throw new MoneyError("Charge cannot be negative");
  if (charge % PRICING.shareDenominator !== 0n) throw new MoneyError("Charge must be divisible by 4");
  const service = charge / PRICING.shareDenominator;
  return { charge, contributor: charge - service, service };
}

export interface OrderSettlement extends Allocation {
  maxCharge: Units;
  acceptedRecords: number;
  refund: Units;
}

/** Final accounting for an order: accepted records are charged, the rest of the maximum is refunded. */
export function settleOrder(totalRecords: number, acceptedRecords: number, ratePer1kUnits: Units): OrderSettlement {
  if (!Number.isInteger(totalRecords) || totalRecords < 0) throw new MoneyError("Invalid record count");
  if (!Number.isInteger(acceptedRecords) || acceptedRecords < 0 || acceptedRecords > totalRecords) {
    throw new MoneyError("Accepted records must be between 0 and the order size");
  }
  const perRecord = perRecordCharge(ratePer1kUnits);
  const maxCharge = perRecord * BigInt(totalRecords);
  const alloc = allocate(perRecord * BigInt(acceptedRecords));
  return { ...alloc, maxCharge, acceptedRecords, refund: maxCharge - alloc.charge };
}

/** Formats units as a fixed six-decimal string, e.g. 2000000n -> "2.000000". */
export function formatUnits(units: Units, decimals: number = SETTLEMENT_ASSET.decimals): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString()}${decimals > 0 ? "." + frac : ""}`;
}

/** Parses a decimal string into units. Rejects more precision than the asset supports. */
export function parseUnits(value: string, decimals: number = SETTLEMENT_ASSET.decimals): Units {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new MoneyError(`Not a decimal amount: ${value}`);
  const frac = m[3] ?? "";
  if (frac.length > decimals) throw new MoneyError("Too many decimal places");
  const units = BigInt(m[2]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return m[1] ? -units : units;
}

export const ONE_UNIT = UNIT;
