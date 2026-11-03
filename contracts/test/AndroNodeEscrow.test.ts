import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, keccak256, toHex, encodeAbiParameters, parseAbiParameters, zeroAddress } from "viem";
import fc from "fast-check";

const U = 1_000_000n; // 6 decimals
const DAY = 24n * 3600n;
const PER_RECORD = 200n; // illustrative $0.20 / 1,000 records

const h = (s: string) => keccak256(toHex(s));

async function deployFixture() {
  const [admin, operator, customer, alice, bob, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("AndroNodeEscrow", [
    usdc.address, admin.account.address, operator.account.address, 500n * U, Number(14n * DAY),
  ]);
  await usdc.write.mint([customer.account.address, 1_000n * U]);
  const asCustomer = await hre.viem.getContractAt("AndroNodeEscrow", escrow.address, { client: { wallet: customer } });
  const usdcCustomer = await hre.viem.getContractAt("MockUSDC", usdc.address, { client: { wallet: customer } });
  await usdcCustomer.write.approve([escrow.address, 1_000n * U]);
  const publicClient = await hre.viem.getPublicClient();
  return { escrow, asCustomer, usdc, admin, operator, customer, alice, bob, stranger, publicClient };
}

async function fund(f: Awaited<ReturnType<typeof deployFixture>>, maxCharge: bigint, quote = "quote-1", hardCloseIn = 14n * DAY) {
  const now = BigInt(await time.latest());
  const quoteHash = h(quote);
  await f.asCustomer.write.fundOrder([maxCharge, quoteHash, h("profile-minilm-v1"), Number(now + hardCloseIn)]);
  return f.escrow.read.orderIdFor([f.customer.account.address, quoteHash]);
}

describe("AndroNodeEscrow", () => {
  describe("deployment", () => {
    it("stores immutable config", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.escrow.read.admin()).to.equal(getAddress(f.admin.account.address));
      expect(await f.escrow.read.maxOutstandingEscrow()).to.equal(500n * U);
    });
    it("rejects zero addresses", async () => {
      const f = await loadFixture(deployFixture);
      await expect(hre.viem.deployContract("AndroNodeEscrow", [f.usdc.address, zeroAddress, f.operator.account.address, 1n, 1])).to.be.rejectedWith("ZeroAddress");
    });
  });

  describe("fundOrder", () => {
    it("derives the order ID from customer and quote, and pulls funds", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 2n * U);
      const expected = keccak256(encodeAbiParameters(parseAbiParameters("uint256, address, address, bytes32"), [31337n, f.escrow.address, f.customer.account.address, h("quote-1")]));
      expect(id).to.equal(expected);
      const o = await f.escrow.read.getOrder([id]);
      expect(o.funded).to.equal(2n * U);
      expect(o.customer).to.equal(getAddress(f.customer.account.address));
      expect(await f.escrow.read.outstandingEscrow()).to.equal(2n * U);
      expect(await f.usdc.read.balanceOf([f.escrow.address])).to.equal(2n * U);
    });
    it("rejects charges not divisible by 4, zero, duplicates, bad hard close, and cap overflow", async () => {
      const f = await loadFixture(deployFixture);
      const now = BigInt(await time.latest());
      const p = h("p");
      await expect(f.asCustomer.write.fundOrder([6n, h("q"), p, Number(now + DAY)])).to.be.rejectedWith("NotDivisibleByFour");
      await expect(f.asCustomer.write.fundOrder([0n, h("q"), p, Number(now + DAY)])).to.be.rejectedWith("InvalidAmount");
      await expect(f.asCustomer.write.fundOrder([4n, h("q"), p, Number(now + 15n * DAY)])).to.be.rejectedWith("InvalidHardClose");
      await expect(f.asCustomer.write.fundOrder([4n, h("q"), p, Number(now)])).to.be.rejectedWith("InvalidHardClose");
      await expect(f.asCustomer.write.fundOrder([501n * U - 1n * U + 4n, h("q"), p, Number(now + DAY)])).to.be.rejectedWith("EscrowCapExceeded");
      await fund(f, 4n, "dup");
      await expect(fund(f, 4n, "dup")).to.be.rejectedWith("OrderExists");
    });
    it("rejects fee-on-transfer tokens", async () => {
      const f = await loadFixture(deployFixture);
      const fee = await hre.viem.deployContract("FeeOnTransferToken");
      const e = await hre.viem.deployContract("AndroNodeEscrow", [fee.address, f.admin.account.address, f.operator.account.address, 500n * U, Number(14n * DAY)]);
      await fee.write.mint([f.admin.account.address, 10n * U]);
      await fee.write.approve([e.address, 10n * U]);
      const now = BigInt(await time.latest());
      await expect(e.write.fundOrder([4n * U, h("q"), h("p"), Number(now + DAY)])).to.be.rejectedWith("TransferAmountMismatch");
    });
    it("is blocked while paused", async () => {
      const f = await loadFixture(deployFixture);
      await f.escrow.write.pause();
      await expect(fund(f, 4n)).to.be.rejectedWith("EnforcedPause");
    });
  });

  describe("settleChunk", () => {
    it("reproduces the whitepaper reference order (10,000 records)", async () => {
      const f = await loadFixture(deployFixture);
      const maxCharge = PER_RECORD * 10_000n; // 2.000000
      const id = await fund(f, maxCharge);
      // 156 tasks of 64 and one of 16 -> pay two contributors
      const aliceUnits = (PER_RECORD * 64n * 100n * 3n) / 4n;
      const bobUnits = (PER_RECORD * (10_000n - 6_400n) * 3n) / 4n;
      await f.escrow.write.settleChunk([id, h("s1"), h("manifest-1"), maxCharge, [f.alice.account.address, f.bob.account.address], [aliceUnits, bobUnits]]);
      expect(await f.escrow.read.claimable([f.alice.account.address]) + (await f.escrow.read.claimable([f.bob.account.address]))).to.equal(1_500_000n);
      expect(await f.escrow.read.claimable([f.operator.account.address])).to.equal(500_000n);
      expect(await f.escrow.read.outstandingEscrow()).to.equal(0n);
    });
    it("partial order: 9,000 accepted -> 0.2 refund after close", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, PER_RECORD * 10_000n);
      const charge = PER_RECORD * 9_000n; // 1.800000
      await f.escrow.write.settleChunk([id, h("s1"), h("m"), charge, [f.alice.account.address], [1_350_000n]]);
      expect(await f.escrow.read.claimable([f.operator.account.address])).to.equal(450_000n);
      await f.escrow.write.closeOrder([id]);
      await f.escrow.write.refundRemainder([id]);
      expect(await f.escrow.read.claimable([f.customer.account.address])).to.equal(200_000n);
    });
    it("only the admin can settle", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 4n * U);
      const asStranger = await hre.viem.getContractAt("AndroNodeEscrow", f.escrow.address, { client: { wallet: f.stranger } });
      await expect(asStranger.write.settleChunk([id, h("s"), h("m"), 4n, [f.alice.account.address], [3n]])).to.be.rejectedWith("NotAdmin");
    });
    it("blocks replay, mismatch, over-funding, dust, too many recipients and zero entries", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 400n);
      const a = f.alice.account.address;
      await f.escrow.write.settleChunk([id, h("s1"), h("m"), 100n, [a], [75n]]);
      await expect(f.escrow.write.settleChunk([id, h("s1"), h("m"), 100n, [a], [75n]])).to.be.rejectedWith("SettlementReplayed");
      await expect(f.escrow.write.settleChunk([id, h("s2"), h("m"), 100n, [a], [74n]])).to.be.rejectedWith("AllocationMismatch");
      await expect(f.escrow.write.settleChunk([id, h("s3"), h("m"), 102n, [a], [76n]])).to.be.rejectedWith("NotDivisibleByFour");
      await expect(f.escrow.write.settleChunk([id, h("s4"), h("m"), 400n, [a], [300n]])).to.be.rejectedWith("ExceedsFunding");
      await expect(f.escrow.write.settleChunk([id, h("s5"), h("m"), 4n, [a, f.bob.account.address], [3n, 0n]])).to.be.rejectedWith("BadRecipients");
      const many = Array.from({ length: 101 }, () => a);
      await expect(f.escrow.write.settleChunk([id, h("s6"), h("m"), 404n, many, many.map(() => 3n)])).to.be.rejectedWith("BadRecipients");
      await expect(f.escrow.write.settleChunk([h("nope"), h("s7"), h("m"), 4n, [a], [3n]])).to.be.rejectedWith("UnknownOrder");
    });
    it("no allocation at or after hard close, or after close", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 400n, "q", 2n * DAY);
      await time.increase(Number(2n * DAY));
      await expect(f.escrow.write.settleChunk([id, h("s"), h("m"), 4n, [f.alice.account.address], [3n]])).to.be.rejectedWith("PastHardClose");
      const id2 = await fund(f, 400n, "q2");
      await f.escrow.write.closeOrder([id2]);
      await expect(f.escrow.write.settleChunk([id2, h("s"), h("m"), 4n, [f.alice.account.address], [3n]])).to.be.rejectedWith("OrderIsClosed");
    });
  });

  describe("refunds and withdrawals", () => {
    it("customer can recover funds after hard close without the admin", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 8n * U, "q", 3n * DAY);
      const asStranger = await hre.viem.getContractAt("AndroNodeEscrow", f.escrow.address, { client: { wallet: f.stranger } });
      await expect(asStranger.write.refundRemainder([id])).to.be.rejectedWith("NotRefundableYet");
      await time.increase(Number(3n * DAY));
      await f.escrow.write.pause(); // refunds still work while paused
      await asStranger.write.refundRemainder([id]);
      await expect(asStranger.write.refundRemainder([id])).to.be.rejectedWith("AlreadyRefunded");
      expect(await f.escrow.read.claimable([f.customer.account.address])).to.equal(8n * U);
      await f.asCustomer.write.withdraw([8n * U, f.customer.account.address]);
      expect(await f.usdc.read.balanceOf([f.customer.account.address])).to.equal(1_000n * U);
    });
    it("withdrawals work while paused and cannot exceed balance", async () => {
      const f = await loadFixture(deployFixture);
      const id = await fund(f, 4n * U);
      await f.escrow.write.settleChunk([id, h("s"), h("m"), 4n * U, [f.alice.account.address], [3n * U]]);
      await f.escrow.write.pause();
      const asAlice = await hre.viem.getContractAt("AndroNodeEscrow", f.escrow.address, { client: { wallet: f.alice } });
      await expect(asAlice.write.withdraw([3n * U + 1n, f.alice.account.address])).to.be.rejectedWith("InsufficientClaimable");
      await asAlice.write.withdraw([3n * U, f.bob.account.address]);
      expect(await f.usdc.read.balanceOf([f.bob.account.address])).to.equal(3n * U);
      expect(await f.escrow.read.claimable([f.alice.account.address])).to.equal(0n);
    });
    it("cap can be raised by admin only", async () => {
      const f = await loadFixture(deployFixture);
      await f.escrow.write.setMaxOutstandingEscrow([1_000n * U]);
      expect(await f.escrow.read.maxOutstandingEscrow()).to.equal(1_000n * U);
      const asStranger = await hre.viem.getContractAt("AndroNodeEscrow", f.escrow.address, { client: { wallet: f.stranger } });
      await expect(asStranger.write.setMaxOutstandingEscrow([1n])).to.be.rejectedWith("NotAdmin");
    });
  });

  describe("invariant: balance == outstanding escrow + total claimable", () => {
    it("holds across random sequences of fund / settle / close / refund / withdraw", async function () {
      this.timeout(120_000);
      const actions = fc.array(
        fc.oneof(
          fc.record({ kind: fc.constant("fund" as const), units: fc.integer({ min: 1, max: 50_000 }) }),
          fc.record({ kind: fc.constant("settle" as const), pct: fc.integer({ min: 1, max: 100 }) }),
          fc.record({ kind: fc.constant("close" as const) }),
          fc.record({ kind: fc.constant("refund" as const) }),
          fc.record({ kind: fc.constant("withdraw" as const), pct: fc.integer({ min: 1, max: 100 }) }),
        ),
        { minLength: 5, maxLength: 25 },
      );
      await fc.assert(
        fc.asyncProperty(actions, async (seq) => {
          const f = await loadFixture(deployFixture);
          const ids: `0x${string}`[] = [];
          let n = 0;
          for (const a of seq) {
            n++;
            try {
              if (a.kind === "fund") ids.push(await fund(f, BigInt(a.units) * 4n, `q${n}`));
              const id = ids.at(-1);
              if (!id) continue;
              if (a.kind === "settle") {
                const left = await f.escrow.read.unallocated([id]);
                const charge = ((left * BigInt(a.pct)) / 100n / 4n) * 4n;
                if (charge > 0n) await f.escrow.write.settleChunk([id, h(`s${n}`), h("m"), charge, [f.alice.account.address], [(charge * 3n) / 4n]]);
              }
              if (a.kind === "close") await f.escrow.write.closeOrder([id]);
              if (a.kind === "refund") await f.escrow.write.refundRemainder([id]);
              if (a.kind === "withdraw") {
                const asAlice = await hre.viem.getContractAt("AndroNodeEscrow", f.escrow.address, { client: { wallet: f.alice } });
                const bal = await f.escrow.read.claimable([f.alice.account.address]);
                const amt = (bal * BigInt(a.pct)) / 100n;
                if (amt > 0n) await asAlice.write.withdraw([amt, f.alice.account.address]);
              }
            } catch {
              // Reverts are allowed; the invariant must still hold.
            }
            const bal = await f.usdc.read.balanceOf([f.escrow.address]);
            const out = await f.escrow.read.outstandingEscrow();
            const cl = await f.escrow.read.totalClaimable();
            if (bal !== out + cl) return false;
          }
          return true;
        }),
        { numRuns: 15 },
      );
    });
  });
});
