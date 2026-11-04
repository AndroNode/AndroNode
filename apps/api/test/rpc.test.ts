import { describe, expect, it } from "vitest";
import { call } from "./helpers";

const rpc = (body: unknown) => call("/v1/rpc", { method: "POST", json: body });

describe("read-only RPC relay", () => {
  it("refuses methods that could send or sign", async () => {
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "eth_accounts", "debug_traceTransaction"]) {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method, params: [] });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe(-32601);
    }
  });
  it("refuses a batch if any call is not a read", async () => {
    const r = await rpc([{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] }]);
    expect(r.status).toBe(400);
  });
  it("rejects malformed and oversized requests", async () => {
    expect((await call("/v1/rpc", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await rpc([])).status).toBe(400);
    expect((await rpc(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId" })))).status).toBe(400);
    expect((await call("/v1/rpc", { method: "POST", body: "x".repeat(40_000) })).status).toBe(413);
  });
  it("refuses browser calls from other sites", async () => {
    const r = await call("/v1/rpc", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "eth_chainId" }, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("does not expose the RPC URL or key in the public config", async () => {
    const r = await call("/v1/config");
    expect(JSON.stringify(r.data)).not.toContain("alchemy");
  });
});
