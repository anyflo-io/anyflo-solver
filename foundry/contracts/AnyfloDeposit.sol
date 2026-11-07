// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AnyfloDeposit - Anyflo contract test double (local demo fixture only).
/// @notice NOT a production Anyflo DepositAccount and not proof of the production contract.
///         It reproduces only the ABI surface the solver consumes (src/evm.ts settlementAbi):
///         the exact `OrderDeposit` event, real ERC20 transfers, direct-deposit semantics
///         (input tokens land on the solver's signer address, which the solver then trades)
///         and protocol-fee separation (the fee is transferred to the fee recipient, never
///         to the solver and never consumed by the swap).
///         Order ref is bytes16(orderId bytes); see src/evm.ts uuidToBytes encoding.
interface IAnyfloDeposit {
	struct Deposit {
		address token;
		uint256 solverAmount;
		uint256 fee;
	}
	/// @dev Exact tuple/event shape verified by the solver (src/evm.ts parseEventLogs, strict).
	event OrderDeposit(
		bytes16 indexed orderId,
		Deposit[] deposits,
		address sender,
		bool directDeposit,
		address solver
	);
}

contract AnyfloDeposit is IAnyfloDeposit {
	using SafeERC20 for IERC20;

	address public immutable feeRecipient;

	constructor(address feeRecipient_) {
		require(feeRecipient_ != address(0), "AnyfloDeposit: zero fee recipient");
		feeRecipient = feeRecipient_;
	}

	/// @notice Customer funds an accepted order. Pulls `solverAmount + fee` from `msg.sender`;
	///         in direct-deposit mode the solver amount is transferred straight to `solver`
	///         (the solver then trades from its own balance) and the fee goes to the fee recipient.
	/// @dev Any mismatch vs the accepted order (reduced amounts, wrong token, wrong solver,
	///      wrong order ref) still emits a real `OrderDeposit` event and reverts nothing here —
	///      exactly the shape the solver's `verifyDeposit` must reject.
	function deposit(bytes16 orderId, IERC20 token, uint256 solverAmount, uint256 fee, address solver, bool directDeposit)
		external
	{
		require(directDeposit, "AnyfloDeposit: only direct deposit supported");
		require(solverAmount > 0, "AnyfloDeposit: zero solver amount");
		require(address(token) != address(0), "AnyfloDeposit: zero token");
		require(solver != address(0), "AnyfloDeposit: zero solver");
		// Real ERC20 transfers: protocol fee separated from the solver amount, both charged to the sender.
		SafeERC20.safeTransferFrom(token, msg.sender, solver, solverAmount);
		if (fee > 0) SafeERC20.safeTransferFrom(token, msg.sender, feeRecipient, fee);
		Deposit[] memory deposits = new Deposit[](1);
		deposits[0] = Deposit(address(token), solverAmount, fee);
		emit OrderDeposit(orderId, deposits, msg.sender, directDeposit, solver);
	}
}
