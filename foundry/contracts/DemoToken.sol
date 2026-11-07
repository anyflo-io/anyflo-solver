// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DemoToken - local 6-decimals test token for the Anyflo solver demo fixture.
/// @notice Fixture-owned test double: mintable only by the deployer, fixed 6 decimals.
///         Not production code and not evidence of any production token behavior.
contract DemoToken is ERC20, Ownable {
	constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) Ownable(owner_) {}

	function decimals() public pure override returns (uint8) {
		return 6;
	}

	function mint(address to, uint256 amount) external onlyOwner {
		_mint(to, amount);
	}
}
