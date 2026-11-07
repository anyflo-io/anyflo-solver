// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { DemoToken } from "../contracts/DemoToken.sol";
import { AnyfloDeposit, IAnyfloDeposit } from "../contracts/AnyfloDeposit.sol";
import { AnyfloDelivery, IAnyfloDelivery } from "../contracts/AnyfloDelivery.sol";

/// @notice Consumer-visible safety proof for the Anyflo settlement doubles: real ERC20 token
/// movement, exact OrderDeposit/OrderDelivered event shapes (as verified by src/evm.ts),
/// direct-deposit semantics and protocol-fee separation. This tests fixture-owned doubles only.
contract SettlementDoublesTest is Test {
	DemoToken token;
	AnyfloDeposit depositAccount;
	AnyfloDelivery deliveryAccount;

	address constant customer = address(0xC1);
	address constant solver = address(0x501);
	address constant feeRecipient = address(0xFEE);
	address constant recipient = address(0xC2);

	uint256 constant solverAmount = 100_000000;
	uint256 constant fee = 1_000000;
	bytes16 constant orderId = bytes16(bytes32(uint256(0x018c6e8e000000000000000000000000aabbccdd11223344)));

	function setUp() public {
		token = new DemoToken("Demo In", "DIN", address(this));
		depositAccount = new AnyfloDeposit(feeRecipient);
		deliveryAccount = new AnyfloDelivery();
		token.mint(customer, 1_000_000000);
		vm.prank(customer);
		token.approve(address(depositAccount), type(uint256).max);
	}


	function test_depositMovesSolverAmountToSolverAndSeparatesFee() public {
		vm.expectEmit(true, false, false, true, address(depositAccount));
		emit IAnyfloDeposit.OrderDeposit(
			orderId,
			_newDeposits(address(token), solverAmount, fee),
			customer,
			true,
			solver
		);
		vm.prank(customer);
		depositAccount.deposit(orderId, token, solverAmount, fee, solver, true);

		assertEq(token.balanceOf(solver), solverAmount, "solver must hold the deposited solver amount");
		assertEq(token.balanceOf(feeRecipient), fee, "protocol fee must land on the fee recipient");
		assertEq(token.balanceOf(customer), 1_000_000000 - solverAmount - fee, "customer must pay amount + fee");
		assertEq(token.balanceOf(address(depositAccount)), 0, "double must not hold custody (direct deposit)");
	}

	function test_depositRevertsOnFailedTransfer() public {
		vm.prank(customer);
		token.approve(address(depositAccount), solverAmount - 1); // insufficient approval for amount + fee
		vm.prank(customer);
		vm.expectRevert();
		depositAccount.deposit(orderId, token, solverAmount, fee, solver, true);
	}

	/// @notice Invalid-deposit scenario: a reduced solverAmount still produces a real OrderDeposit
	/// receipt whose amounts mismatch the accepted order — exactly what verifyDeposit must reject.
	function test_mismatchedDepositStillEmitsRealEvent() public {
		uint256 reduced = solverAmount / 2;
		vm.expectEmit(true, false, false, true, address(depositAccount));
		emit IAnyfloDeposit.OrderDeposit(
			orderId,
			_newDeposits(address(token), reduced, fee),
			customer,
			true,
			solver
		);
		vm.prank(customer);
		depositAccount.deposit(orderId, token, reduced, fee, solver, true);

		assertEq(token.balanceOf(solver), reduced, "reduced deposit must move the reduced amount");
	}

	function test_payoutMovesOutputTokensAndEmitsExactEvent() public {
		token.mint(solver, solverAmount);
		vm.prank(solver);
		token.approve(address(deliveryAccount), solverAmount);

		vm.expectEmit(true, true, true, true, address(deliveryAccount));
		emit IAnyfloDelivery.OrderDelivered(orderId, recipient, solver, solverAmount, address(token));
		vm.prank(solver);
		deliveryAccount.payout(orderId, token, solverAmount, recipient);

		assertEq(token.balanceOf(recipient), solverAmount, "recipient must receive the exact payout");
		assertEq(token.balanceOf(solver), 0, "solver must not retain the payout");
		assertEq(token.balanceOf(address(deliveryAccount)), 0, "double must not hold custody");
	}

	function test_payoutRevertsWithoutAllowance() public {
		token.mint(solver, solverAmount);
		vm.prank(solver);
		vm.expectRevert();
		deliveryAccount.payout(orderId, token, solverAmount, recipient);
	}

	function _newDeposits(address token_, uint256 solverAmount_, uint256 fee_)
		private
		pure
		returns (IAnyfloDeposit.Deposit[] memory deposits)
	{
		deposits = new IAnyfloDeposit.Deposit[](1);
		deposits[0] = IAnyfloDeposit.Deposit(token_, solverAmount_, fee_);
	}
}
