import { time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

describe("TestUSDC", () => {
  it("has 6 decimals and a test-only name", async () => {
    const t = await hre.viem.deployContract("TestUSDC");
    expect(await t.read.decimals()).to.equal(6);
    expect(await t.read.symbol()).to.equal("tUSDC");
    expect(await t.read.totalSupply()).to.equal(0n);
  });

  it("faucet pays 1,000 tUSDC once per day per address", async () => {
    const [a, b] = await hre.viem.getWalletClients();
    const t = await hre.viem.deployContract("TestUSDC");
    await t.write.faucet([], { account: a.account });
    expect(await t.read.balanceOf([a.account.address])).to.equal(1_000_000_000n);
    await expect(t.write.faucet([], { account: a.account })).to.be.rejectedWith("FaucetCooldown");
    await t.write.faucet([], { account: b.account });
    expect(await t.read.balanceOf([b.account.address])).to.equal(1_000_000_000n);
    await time.increase(24 * 3600);
    await t.write.faucet([], { account: a.account });
    expect(await t.read.balanceOf([a.account.address])).to.equal(2_000_000_000n);
  });

  it("works as the escrow asset", async () => {
    const [admin, operator, customer] = await hre.viem.getWalletClients();
    const t = await hre.viem.deployContract("TestUSDC");
    const escrow = await hre.viem.deployContract("AndroNodeEscrow", [t.address, admin.account.address, operator.account.address, 500_000_000n, 1_209_600]);
    await t.write.faucet([], { account: customer.account });
    await t.write.approve([escrow.address, 10_000_000n], { account: customer.account });
    const now = BigInt(await time.latest());
    const q = "0x" + "11".repeat(32);
    await escrow.write.fundOrder([10_000_000n, q as `0x${string}`, ("0x" + "22".repeat(32)) as `0x${string}`, Number(now + 86400n)], { account: customer.account });
    expect(await t.read.balanceOf([escrow.address])).to.equal(10_000_000n);
  });
});
