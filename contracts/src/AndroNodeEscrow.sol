// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title AndroNodeEscrow
/// @notice Single-asset escrow for AndroNode compute orders (Whitepaper v1.0, section 13).
/// Customers fund an order up to a maximum charge. The admin (a 2-of-3 Safe) settles
/// accepted work in chunks, split exactly 75% to contributors and 25% to the operator.
/// Everyone is paid by pull withdrawal. Unallocated funds are refundable once the order
/// is closed, or by anyone after the hard-close time without the admin.
/// @dev Non-upgradeable by design. This contract does not and cannot judge whether AI work
/// was correct; it only enforces the funding, split and replay rules.
contract AndroNodeEscrow is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Order {
        address customer;
        uint64 fundedAt;
        uint64 hardCloseAt;
        bool closed;
        bool refunded;
        uint256 funded;
        uint256 allocated;
        bytes32 quoteHash;
        bytes32 profileId;
    }

    uint256 public constant MAX_RECIPIENTS = 100;
    uint256 public constant SHARE_DENOMINATOR = 4; // 3/4 contributor, 1/4 operator

    IERC20 public immutable asset;
    address public immutable admin;
    address public immutable operatorTreasury;
    uint64 public immutable maxHardCloseWindow;

    uint256 public maxOutstandingEscrow;
    uint256 public outstandingEscrow;
    uint256 public totalClaimable;

    mapping(bytes32 orderId => Order) private _orders;
    mapping(bytes32 settlementId => bool) public processedSettlement;
    mapping(address account => uint256) public claimable;

    event OrderFunded(bytes32 indexed orderId, address indexed customer, uint256 maxCharge, bytes32 quoteHash, bytes32 profileId, uint64 hardCloseAt);
    event SettlementApplied(bytes32 indexed orderId, bytes32 indexed settlementId, bytes32 manifestHash, uint256 charge, uint256 contributorTotal, uint256 operatorAmount, uint256 recipientCount);
    event ContributorCredited(bytes32 indexed settlementId, address indexed recipient, uint256 amount);
    event OrderClosed(bytes32 indexed orderId, uint256 allocated, uint256 unallocated);
    event RemainderRefunded(bytes32 indexed orderId, address indexed customer, uint256 amount, bool afterHardClose);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event MaxOutstandingEscrowSet(uint256 previousCap, uint256 newCap);

    error NotAdmin();
    error ZeroAddress();
    error InvalidAmount();
    error NotDivisibleByFour();
    error OrderExists();
    error UnknownOrder();
    error OrderIsClosed();
    error InvalidHardClose();
    error EscrowCapExceeded();
    error TransferAmountMismatch();
    error SettlementReplayed();
    error PastHardClose();
    error BadRecipients();
    error AllocationMismatch();
    error ExceedsFunding();
    error NotRefundableYet();
    error AlreadyRefunded();
    error InsufficientClaimable();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IERC20 asset_, address admin_, address operatorTreasury_, uint256 maxOutstandingEscrow_, uint64 maxHardCloseWindow_) {
        if (address(asset_) == address(0) || admin_ == address(0) || operatorTreasury_ == address(0)) revert ZeroAddress();
        if (maxHardCloseWindow_ == 0) revert InvalidHardClose();
        asset = asset_;
        admin = admin_;
        operatorTreasury = operatorTreasury_;
        maxOutstandingEscrow = maxOutstandingEscrow_;
        maxHardCloseWindow = maxHardCloseWindow_;
        emit MaxOutstandingEscrowSet(0, maxOutstandingEscrow_);
    }

    // ------------------------------------------------------------------ views

    /// @notice Order IDs are derived from the funder and the quote, so nobody can squat another customer's ID.
    function orderIdFor(address customer, bytes32 quoteHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), customer, quoteHash));
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function unallocated(bytes32 orderId) public view returns (uint256) {
        Order storage o = _orders[orderId];
        if (o.refunded) return 0;
        return o.funded - o.allocated;
    }

    // --------------------------------------------------------------- customer

    /// @notice Funds an order. Caller must have approved `maxCharge` of the asset.
    function fundOrder(uint256 maxCharge, bytes32 quoteHash, bytes32 profileId, uint64 hardCloseAt)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 orderId)
    {
        if (maxCharge == 0) revert InvalidAmount();
        if (maxCharge % SHARE_DENOMINATOR != 0) revert NotDivisibleByFour();
        if (hardCloseAt <= block.timestamp || hardCloseAt > block.timestamp + maxHardCloseWindow) revert InvalidHardClose();
        if (outstandingEscrow + maxCharge > maxOutstandingEscrow) revert EscrowCapExceeded();

        orderId = orderIdFor(msg.sender, quoteHash);
        if (_orders[orderId].customer != address(0)) revert OrderExists();

        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), maxCharge);
        if (asset.balanceOf(address(this)) - before != maxCharge) revert TransferAmountMismatch();

        _orders[orderId] = Order({
            customer: msg.sender,
            fundedAt: uint64(block.timestamp),
            hardCloseAt: hardCloseAt,
            closed: false,
            refunded: false,
            funded: maxCharge,
            allocated: 0,
            quoteHash: quoteHash,
            profileId: profileId
        });
        outstandingEscrow += maxCharge;
        emit OrderFunded(orderId, msg.sender, maxCharge, quoteHash, profileId, hardCloseAt);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Credits accepted work for one order. Recipients receive exactly 3/4 of `charge`, the operator 1/4.
    function settleChunk(
        bytes32 orderId,
        bytes32 settlementId,
        bytes32 manifestHash,
        uint256 charge,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyAdmin whenNotPaused {
        Order storage o = _orders[orderId];
        if (o.customer == address(0)) revert UnknownOrder();
        if (o.closed) revert OrderIsClosed();
        if (block.timestamp >= o.hardCloseAt) revert PastHardClose();
        if (processedSettlement[settlementId]) revert SettlementReplayed();
        if (charge == 0) revert InvalidAmount();
        if (charge % SHARE_DENOMINATOR != 0) revert NotDivisibleByFour();
        uint256 n = recipients.length;
        if (n == 0 || n > MAX_RECIPIENTS || n != amounts.length) revert BadRecipients();
        if (o.allocated + charge > o.funded) revert ExceedsFunding();

        uint256 operatorAmount = charge / SHARE_DENOMINATOR;
        uint256 contributorTotal = charge - operatorAmount;

        processedSettlement[settlementId] = true;
        o.allocated += charge;
        outstandingEscrow -= charge;
        totalClaimable += charge;

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address r = recipients[i];
            uint256 a = amounts[i];
            if (r == address(0) || a == 0) revert BadRecipients();
            sum += a;
            claimable[r] += a;
            emit ContributorCredited(settlementId, r, a);
        }
        if (sum != contributorTotal) revert AllocationMismatch();
        claimable[operatorTreasury] += operatorAmount;

        emit SettlementApplied(orderId, settlementId, manifestHash, charge, contributorTotal, operatorAmount, n);
    }

    /// @notice Marks final reconciliation done; the unallocated balance becomes refundable.
    function closeOrder(bytes32 orderId) external onlyAdmin {
        Order storage o = _orders[orderId];
        if (o.customer == address(0)) revert UnknownOrder();
        if (o.closed) revert OrderIsClosed();
        o.closed = true;
        emit OrderClosed(orderId, o.allocated, o.funded - o.allocated);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function setMaxOutstandingEscrow(uint256 newCap) external onlyAdmin {
        emit MaxOutstandingEscrowSet(maxOutstandingEscrow, newCap);
        maxOutstandingEscrow = newCap;
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Moves an order's unallocated funds to the customer's claimable balance.
    /// Works after `closeOrder`, or after the hard-close time with no admin action. Never paused.
    function refundRemainder(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.customer == address(0)) revert UnknownOrder();
        if (o.refunded) revert AlreadyRefunded();
        bool afterHardClose = block.timestamp >= o.hardCloseAt;
        if (!o.closed && !afterHardClose) revert NotRefundableYet();

        uint256 amount = o.funded - o.allocated;
        o.refunded = true;
        o.closed = true;
        outstandingEscrow -= amount;
        if (amount > 0) {
            claimable[o.customer] += amount;
            totalClaimable += amount;
        }
        emit RemainderRefunded(orderId, o.customer, amount, afterHardClose);
    }

    /// @notice Pull payment of the caller's own credited balance. Never paused.
    function withdraw(uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 bal = claimable[msg.sender];
        if (amount > bal) revert InsufficientClaimable();
        claimable[msg.sender] = bal - amount;
        totalClaimable -= amount;
        asset.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }
}
