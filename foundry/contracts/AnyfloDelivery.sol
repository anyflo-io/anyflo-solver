// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AnyfloDelivery - Anyflo contract test double (local demo fixture only).
/// @notice NOT a production Anyflo DeliveryAccount and not proof of the production contract.
///         It reproduces only the ABI surface the solver consumes (src/evm.ts settlementAbi):
///         the exact `payout(bytes16,address,uint256,address)` entrypoint and `OrderDelivered`
///         event, moving real ERC20 output tokens from the solver (which approves this account
///         for the exact payout amount) to the order recipient.
///         Order ref is bytes16(orderId bytes); see src/evm.ts uuidToBytes encoding.
interface IAnyfloDelivery {
	/// @dev Exact event shape verified by the solver (src/evm.ts parseEventLogs, strict).
	event OrderDelivered(bytes16 indexed orderId, address indexed recipient, address sender, uint256 amount, address indexed token);
}

contract AnyfloDelivery is IAnyfloDelivery {
	using SafeERC20 for IERC20;

	/// @notice Solver pays out a delivered order: pulls `amount` of `token` from `msg.sender`
	///         (the solver, which approved exactly this amount via src/evm.ts approve) and
	///         transfers it to `recipient`, emitting the exact `OrderDelivered` event.
	function payout(bytes16 orderId, IERC20 token, uint256 amount, address recipient) external {
		require(amount > 0, "AnyfloDelivery: zero amount");
		require(address(token) != address(0), "AnyfloDelivery: zero token");
		require(recipient != address(0), "AnyfloDelivery: zero recipient");
		require(msg.sender != recipient, "AnyfloDelivery: self payout");
		SafeERC20.safeTransferFrom(token, msg.sender, recipient, amount);
		emit OrderDelivered(orderId, recipient, msg.sender, amount, address(token));
	}
}
