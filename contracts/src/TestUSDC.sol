// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title AndroNode Test USDC
/// @notice Valueless 6-decimal stand-in for USDC on testnets that have no official USDC
///         (Robinhood Chain testnet). Anyone can claim a small amount from the faucet once per cooldown.
///         Refuses to deploy on known mainnets so it can never be mistaken for real money.
contract TestUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 * 1e6; // 1,000 tUSDC
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastClaim;

    error MainnetNotAllowed();
    error FaucetCooldown(uint256 availableAt);

    event FaucetClaimed(address indexed to, uint256 amount);

    constructor() ERC20("AndroNode Test USDC", "tUSDC") {
        // Ethereum, Base, Arbitrum One, Optimism, Polygon, Robinhood Chain mainnet.
        if (block.chainid == 1 || block.chainid == 8453 || block.chainid == 42161 || block.chainid == 10 || block.chainid == 137 || block.chainid == 4663) {
            revert MainnetNotAllowed();
        }
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Sends FAUCET_AMOUNT to the caller, at most once per FAUCET_COOLDOWN.
    function faucet() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }
}
