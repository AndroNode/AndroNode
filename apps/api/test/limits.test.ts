import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("rate limits", () => {
  it("throttles repeated sign-in attempts from one address", async () => {
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await call("/v1/auth/nonce", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await call("/v1/auth/nonce", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  });
});
